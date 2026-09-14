import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { SESSION_COOKIE } from '../lib/config.ts';
import { getWebRuntime } from '../lib/runtime.ts';

export const dynamic = 'force-dynamic';

const AUTH_ERRORS: Record<string, string> = {
  LOGIN_REFUSED: 'The local identity provider refused or cancelled the sign-in.',
  LOGIN_STATE_MISSING: 'That sign-in link was already used or has expired. Start again.',
  LOGIN_STATE_MISMATCH: 'The sign-in response did not match the request this browser started. It was refused.',
  LOGIN_CODE_MISSING: 'The local identity provider did not return an authorization code.',
  LOGIN_EXCHANGE_FAILED: 'The authorization code could not be exchanged with the local identity provider.',
  LOGIN_PROVIDER_UNAVAILABLE:
    'The local identity provider could not be reached. Start it with "npm run dev:oidc" in the repository root and try again.',
};

export default async function HomePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const runtime = getWebRuntime();
  const store = await cookies();
  if (runtime.sessions.get(store.get(SESSION_COOKIE)?.value)) redirect('/purchase');

  const authError = (await searchParams).authError;
  const message = typeof authError === 'string' ? AUTH_ERRORS[authError] ?? 'Sign-in failed.' : null;

  return (
    <main className="page">
      <h1>PharmaCart local purchase loop</h1>
      <p className="lede">
        Local synthetic environment only. Data, organisations, products and suppliers are invented, and
        no real pharmacy, supplier or payment system is contacted.
      </p>
      {message ? (
        <div className="alert" role="alert">
          {message}
        </div>
      ) : null}
      <p>
        <a className="primary-link" href="/auth/login">
          Sign in with the local identity provider
        </a>
      </p>
      <p className="hint">
        Sign-in uses the local development OIDC provider on its own public client. Tokens stay on this
        server; the browser only receives an opaque session cookie.
      </p>
    </main>
  );
}
