import { describe, expect, it } from 'vitest';

import { MAX_LIVE_SESSIONS, MAX_PENDING_LOGINS, PENDING_LOGIN_SECONDS } from '../../src/lib/config.ts';
import { createInMemorySessionStore, toSessionView } from '../../src/lib/session.ts';

const START = 1_800_000_000_000;

function store(now: { value: number }, overrides: { environment?: string; maxSessionSeconds?: number } = {}) {
  return createInMemorySessionStore({
    now: () => now.value,
    maxSessionSeconds: 300,
    ...overrides,
  });
}

describe('in-memory web session store', () => {
  it('refuses to run in production because storage is development-only', () => {
    expect(() => createInMemorySessionStore({ now: () => START, environment: 'production' }))
      .toThrow(/development only/i);
  });

  it('issues an opaque session identifier that is not derived from the access token', () => {
    const now = { value: START };
    const sessions = store(now);
    const session = sessions.create({ accessToken: 'header.payload.signature', accessTokenExpiresAt: START + 300_000 });
    expect(session.id).not.toContain('header');
    expect(session.id).not.toContain('payload');
    expect(session.id.length).toBeGreaterThanOrEqual(32);
    expect(session.csrfToken.length).toBeGreaterThanOrEqual(32);
    expect(session.csrfToken).not.toBe(session.id);
  });

  it('never lets a session outlive its access token', () => {
    const now = { value: START };
    const sessions = store(now);
    const short = sessions.create({ accessToken: 'a', accessTokenExpiresAt: START + 30_000 });
    expect(short.expiresAt).toBe(START + 30_000);

    const long = sessions.create({ accessToken: 'b', accessTokenExpiresAt: START + 3_600_000 });
    expect(long.expiresAt).toBe(START + 300_000);
  });

  it('refuses to create a session for an already expired access token', () => {
    const now = { value: START };
    expect(() => store(now).create({ accessToken: 'a', accessTokenExpiresAt: START })).toThrow(/expired/i);
  });

  it('evicts an expired session instead of returning it', () => {
    const now = { value: START };
    const sessions = store(now);
    const session = sessions.create({ accessToken: 'a', accessTokenExpiresAt: START + 60_000 });
    expect(sessions.get(session.id)?.id).toBe(session.id);
    now.value = START + 60_000;
    expect(sessions.get(session.id)).toBeNull();
    expect(sessions.size()).toBe(0);
  });

  it('treats missing and unknown identifiers as no session', () => {
    const sessions = store({ value: START });
    expect(sessions.get(null)).toBeNull();
    expect(sessions.get(undefined)).toBeNull();
    expect(sessions.get('')).toBeNull();
    expect(sessions.get('not-a-session')).toBeNull();
  });

  it('destroys a session so a replayed cookie cannot resurrect it', () => {
    const now = { value: START };
    const sessions = store(now);
    const session = sessions.create({ accessToken: 'a', accessTokenExpiresAt: START + 60_000 });
    sessions.destroy(session.id);
    expect(sessions.get(session.id)).toBeNull();
  });

  it('keeps the access token out of the browser-facing session view', () => {
    const now = { value: START };
    const sessions = store(now);
    const session = sessions.create({ accessToken: 'super-secret-token', accessTokenExpiresAt: START + 60_000 });
    const view = toSessionView(session);
    expect(JSON.stringify(view)).not.toContain('super-secret-token');
    expect(Object.keys(view).sort()).toEqual(['csrfToken', 'expiresAt', 'scope', 'subject']);
  });

  it('stores a stable idempotency key per quote version and a new one per new version', () => {
    const now = { value: START };
    const sessions = store(now);
    const session = sessions.create({ accessToken: 'a', accessTokenExpiresAt: START + 60_000 });

    const first = sessions.approvalKey(session.id, 'quote-1', 1);
    const retry = sessions.approvalKey(session.id, 'quote-1', 1);
    const requoted = sessions.approvalKey(session.id, 'quote-2', 1);
    const newVersion = sessions.approvalKey(session.id, 'quote-1', 2);

    expect(retry).toBe(first);
    expect(requoted).not.toBe(first);
    expect(newVersion).not.toBe(first);
    expect(first).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it('stores a receipt reference that is stable for identical lines and new for different lines', () => {
    const now = { value: START };
    const sessions = store(now);
    const session = sessions.create({ accessToken: 'a', accessTokenExpiresAt: START + 60_000 });
    const lines = [{ lineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: '2' }];
    const same = [{ lineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: '2' }];
    const other = [{ lineId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', quantity: '1' }];

    const reference = sessions.receiptReference(session.id, 'intent-1', lines);
    expect(sessions.receiptReference(session.id, 'intent-1', same)).toBe(reference);
    expect(sessions.receiptReference(session.id, 'intent-1', other)).not.toBe(reference);
    expect(sessions.receiptReference(session.id, 'intent-2', lines)).not.toBe(reference);
    expect(reference.length).toBeLessThanOrEqual(128);
  });

  it('keeps the login state and PKCE verifier server-side behind an opaque single-use handle', () => {
    const now = { value: START };
    const sessions = store(now);
    const handle = sessions.createPendingLogin({ state: 'the-state', codeVerifier: 'the-verifier' });

    expect(handle).not.toContain('the-state');
    expect(handle).not.toContain('the-verifier');
    expect(handle.length).toBeGreaterThanOrEqual(32);

    expect(sessions.takePendingLogin(handle)).toEqual({ state: 'the-state', codeVerifier: 'the-verifier' });
    expect(sessions.takePendingLogin(handle)).toBeNull();
  });

  it('expires an abandoned pending login instead of keeping it forever', () => {
    const now = { value: START };
    const sessions = store(now);
    const handle = sessions.createPendingLogin({ state: 's', codeVerifier: 'v' });
    now.value = START + 600_000;
    expect(sessions.takePendingLogin(handle)).toBeNull();
  });

  it('does not hand out approval keys or receipt references for an unknown session', () => {
    const sessions = store({ value: START });
    expect(() => sessions.approvalKey('missing', 'quote-1', 1)).toThrow();
    expect(() => sessions.receiptReference('missing', 'intent-1', [])).toThrow();
  });
});

/**
 * `GET /auth/login` is reachable without a session, including as a cross-site top-level navigation,
 * and every hit allocates a pending login that is only removed when a matching callback consumes it.
 * Without a bound, a stream of abandoned sign-in starts grows this process's memory until it is
 * restarted. Sessions are gated behind a completed code exchange, so they are the lesser risk, but
 * they were equally unbounded.
 */
describe('session store growth bounds', () => {
  it('sweeps expired pending logins instead of holding them for the life of the process', () => {
    const now = { value: START };
    const sessions = store(now);
    sessions.createPendingLogin({ state: 's1', codeVerifier: 'v1' });
    sessions.createPendingLogin({ state: 's2', codeVerifier: 'v2' });
    expect(sessions.pendingSize()).toBe(2);

    now.value = START + PENDING_LOGIN_SECONDS * 1000 + 1;
    sessions.createPendingLogin({ state: 's3', codeVerifier: 'v3' });
    expect(sessions.pendingSize()).toBe(1);
  });

  it('caps unauthenticated pending logins so abandoned sign-ins cannot grow without bound', () => {
    const now = { value: START };
    const sessions = store(now);
    const handles: string[] = [];
    for (let index = 0; index < MAX_PENDING_LOGINS + 64; index += 1) {
      handles.push(sessions.createPendingLogin({ state: `s${index}`, codeVerifier: `v${index}` }));
    }
    expect(sessions.pendingSize()).toBeLessThanOrEqual(MAX_PENDING_LOGINS);

    // Eviction is oldest first, so the most recent attempt is the one that still completes.
    expect(sessions.takePendingLogin(handles[0]!)).toBeNull();
    expect(sessions.takePendingLogin(handles.at(-1)!))
      .toMatchObject({ state: `s${MAX_PENDING_LOGINS + 63}` });
  });

  it('sweeps expired sessions and caps live ones', () => {
    const now = { value: START };
    const sessions = store(now);
    sessions.create({ accessToken: 'a', accessTokenExpiresAt: START + 300_000 });
    now.value = START + 300_001;
    sessions.create({ accessToken: 'b', accessTokenExpiresAt: now.value + 300_000 });
    expect(sessions.size()).toBe(1);

    for (let index = 0; index < MAX_LIVE_SESSIONS + 32; index += 1) {
      sessions.create({ accessToken: `t${index}`, accessTokenExpiresAt: now.value + 300_000 });
    }
    expect(sessions.size()).toBeLessThanOrEqual(MAX_LIVE_SESSIONS);
  });
});
