/**
 * Unauthenticated local smoke probe for a running dev server.
 *
 * Read-only: it only asks the app about its own refusals. It never signs in, never reaches the API
 * or the database, and never places an order. Run it with `npm run probe` while `npm run dev` is up.
 */
const base = process.env.PHARMACART_WEB_ORIGIN ?? 'http://127.0.0.1:3001';

async function probe(label, path, init = {}) {
  const response = await fetch(`${base}${path}`, { redirect: 'manual', ...init });
  const body = await response.text();
  const location = response.headers.get('location');
  process.stdout.write(
    `${label}: ${response.status}${location ? ` -> ${location}` : ''}` +
      `${body && body.length < 300 ? ` :: ${body.replace(/\s+/g, ' ').slice(0, 200)}` : ''}\n`,
  );
  return body;
}

const home = await probe('GET /', '/');
process.stdout.write(`  sign-in link present: ${home.includes('/auth/login')}\n`);
await probe('GET /purchase (anonymous)', '/purchase');
await probe('GET /api/bff/session (anonymous)', '/api/bff/session');
await probe('POST /api/bff/scope (foreign origin)', '/api/bff/scope', {
  method: 'POST',
  headers: { origin: 'http://evil.example.com', 'content-type': 'application/json' },
  body: '{}',
});
await probe('POST /api/bff/scope (same origin, no session)', '/api/bff/scope', {
  method: 'POST',
  headers: { origin: base, 'content-type': 'application/json' },
  body: '{}',
});
// An oversized body must still lose to the session check: the bound exists so that an authenticated
// caller cannot stream an unbounded body, not so that a stranger gets a more informative refusal.
await probe('POST /api/bff/scope (oversized body, no session)', '/api/bff/scope', {
  method: 'POST',
  headers: { origin: base, 'content-type': 'application/json' },
  body: JSON.stringify({ pad: 'x'.repeat(20_000) }),
});
await probe('GET /auth/login', '/auth/login');

const headers = (await fetch(`${base}/`)).headers;
const named = ['x-content-type-options', 'x-frame-options', 'referrer-policy', 'x-powered-by'];
process.stdout.write(`response headers: ${named.map((name) => `${name}=${headers.get(name)}`).join(' ')}\n`);
