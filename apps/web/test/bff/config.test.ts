import { describe, expect, it } from 'vitest';

import {
  CALLBACK_PATH,
  ConfigurationError,
  DEFAULT_API_ORIGIN,
  DEFAULT_OIDC_ISSUER,
  DEFAULT_WEB_ORIGIN,
  WEB_CLIENT_ID,
  assertLoopbackOrigin,
  loadWebConfig,
} from '../../src/lib/config.ts';

describe('web configuration', () => {
  it('defaults to the documented local loopback services', () => {
    const config = loadWebConfig({});
    expect(config.webOrigin).toBe(DEFAULT_WEB_ORIGIN);
    expect(config.apiOrigin).toBe(DEFAULT_API_ORIGIN);
    expect(config.oidcIssuer).toBe(DEFAULT_OIDC_ISSUER);
    expect(config.clientId).toBe(WEB_CLIENT_ID);
    expect(config.redirectUri).toBe(`${DEFAULT_WEB_ORIGIN}${CALLBACK_PATH}`);
    expect(config.resource).toBe(DEFAULT_API_ORIGIN);
    expect(config.sessionMaxSeconds).toBe(300);
  });

  it('keeps the registered client identifier separate from the existing API client', () => {
    expect(WEB_CLIENT_ID).toBe('pharmacart-web-local');
    expect(WEB_CLIENT_ID).not.toBe('pharmacart-local');
    expect(loadWebConfig({}).redirectUri).toBe('http://127.0.0.1:3001/auth/callback');
  });

  it.each([
    ['https://identity.example.com', 'remote https origin'],
    ['http://identity.example.com', 'remote http origin'],
    ['http://localhost:3000', 'non-loopback-literal host'],
    ['http://127.0.0.1:3000/proxy', 'origin carrying a path'],
    ['http://127.0.0.1:3000?target=x', 'origin carrying a query'],
    ['http://user:pass@127.0.0.1:3000', 'origin carrying credentials'],
    ['not-a-url', 'unparseable value'],
  ])('refuses %s as an API destination (%s)', (value) => {
    expect(() => loadWebConfig({ PHARMACART_WEB_API_ORIGIN: value })).toThrow(ConfigurationError);
  });

  it('refuses a non-loopback OIDC issuer and a non-loopback web origin', () => {
    expect(() => loadWebConfig({ PHARMACART_WEB_OIDC_ISSUER: 'https://sso.example.com' })).toThrow(ConfigurationError);
    expect(() => loadWebConfig({ PHARMACART_WEB_ORIGIN: 'http://10.0.0.5:3001' })).toThrow(ConfigurationError);
  });

  it('accepts another loopback port and normalises it to a bare origin', () => {
    const config = loadWebConfig({ PHARMACART_WEB_API_ORIGIN: 'http://127.0.0.1:3100/' });
    expect(config.apiOrigin).toBe('http://127.0.0.1:3100');
    expect(config.resource).toBe('http://127.0.0.1:3100');
  });

  it('refuses a session bound that is not a positive integer within the documented range', () => {
    expect(() => loadWebConfig({ PHARMACART_WEB_SESSION_MAX_SECONDS: '0' })).toThrow(ConfigurationError);
    expect(() => loadWebConfig({ PHARMACART_WEB_SESSION_MAX_SECONDS: '-5' })).toThrow(ConfigurationError);
    expect(() => loadWebConfig({ PHARMACART_WEB_SESSION_MAX_SECONDS: 'abc' })).toThrow(ConfigurationError);
    expect(() => loadWebConfig({ PHARMACART_WEB_SESSION_MAX_SECONDS: '100000' })).toThrow(ConfigurationError);
    expect(loadWebConfig({ PHARMACART_WEB_SESSION_MAX_SECONDS: '120' }).sessionMaxSeconds).toBe(120);
  });

  it('exposes the loopback assertion for reuse and returns the bare origin', () => {
    expect(assertLoopbackOrigin('http://127.0.0.1:55433', 'issuer')).toBe('http://127.0.0.1:55433');
    expect(() => assertLoopbackOrigin('http://[::1]:3000', 'issuer')).toThrow(ConfigurationError);
  });
});
