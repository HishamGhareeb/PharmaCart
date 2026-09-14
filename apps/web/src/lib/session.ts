import { createHash, randomBytes } from 'node:crypto';

import {
  DEFAULT_SESSION_SECONDS,
  MAX_LIVE_SESSIONS,
  MAX_PENDING_LOGINS,
  PENDING_LOGIN_SECONDS,
} from './config.ts';

/**
 * Development-only session storage.
 *
 * Sessions live in this process's memory and are lost on restart. That is acceptable for the local
 * synthetic loop and is refused outright when NODE_ENV is production, because a real deployment would
 * need shared, revocable, durable storage. See docs/testing/local-web-loop.md.
 */

export type SessionScope = Readonly<{
  organisationId: string;
  branchId: string;
  organisationKind: string;
  role: string;
}>;

export type WebSession = {
  readonly id: string;
  /** Server-only. Never serialised into a response body, header or cookie. */
  readonly accessToken: string;
  readonly accessTokenExpiresAt: number;
  readonly expiresAt: number;
  readonly csrfToken: string;
  subject: string | null;
  scope: SessionScope | null;
  readonly approvalKeys: Map<string, string>;
  readonly receiptReferences: Map<string, string>;
};

export type SessionView = {
  subject: string | null;
  scope: SessionScope | null;
  csrfToken: string;
  expiresAt: number;
};

export type ReceiptLine = { lineId: string; quantity: string };

export type PendingLogin = { state: string; codeVerifier: string };

export type SessionStore = {
  now(): number;
  create(input: { accessToken: string; accessTokenExpiresAt: number }): WebSession;
  get(id: string | null | undefined): WebSession | null;
  destroy(id: string): void;
  size(): number;
  pendingSize(): number;
  approvalKey(sessionId: string, quoteId: string, quoteVersion: number): string;
  receiptReference(sessionId: string, intentId: string, lines: readonly ReceiptLine[]): string;
  createPendingLogin(pending: PendingLogin): string;
  takePendingLogin(handle: string): PendingLogin | null;
};

export function toSessionView(session: WebSession): SessionView {
  return {
    subject: session.subject,
    scope: session.scope,
    csrfToken: session.csrfToken,
    expiresAt: session.expiresAt,
  };
}

function opaqueToken(): string {
  return randomBytes(32).toString('base64url');
}

function receiptKey(intentId: string, lines: readonly ReceiptLine[]): string {
  const canonical = [...lines]
    .map((line) => ({ lineId: line.lineId, quantity: line.quantity }))
    .sort((a, b) => a.lineId.localeCompare(b.lineId));
  return `${intentId}:${createHash('sha256').update(JSON.stringify(canonical)).digest('hex')}`;
}

export function createInMemorySessionStore(options: {
  now: () => number;
  environment?: string | undefined;
  maxSessionSeconds?: number | undefined;
}): SessionStore {
  const environment = options.environment ?? process.env.NODE_ENV;
  if (environment === 'production') {
    throw new Error('The PharmaCart web session store is development only and refuses to run in production');
  }

  const maxSessionSeconds = options.maxSessionSeconds ?? DEFAULT_SESSION_SECONDS;
  const sessions = new Map<string, WebSession>();
  const pendingLogins = new Map<string, PendingLogin & { expiresAt: number }>();
  const now = options.now;

  function live(id: string | null | undefined): WebSession | null {
    if (!id) return null;
    const session = sessions.get(id);
    if (!session) return null;
    if (now() >= session.expiresAt) {
      sessions.delete(id);
      return null;
    }
    return session;
  }

  function required(sessionId: string): WebSession {
    const session = live(sessionId);
    if (!session) throw new Error('No live session for the supplied identifier');
    return session;
  }

  /**
   * Drops everything already expired, then makes room for one more entry by evicting the oldest.
   * Nothing here is reclaimed on a timer, and an abandoned entry is never read again, so without
   * this both maps grow for as long as the dev server runs. Map iteration is insertion-ordered, so
   * "oldest first" needs no extra bookkeeping.
   */
  function makeRoom(entries: Map<string, { expiresAt: number }>, limit: number): void {
    const current = now();
    for (const [key, entry] of entries) {
      if (current >= entry.expiresAt) entries.delete(key);
    }
    while (entries.size >= limit) {
      const oldest = entries.keys().next();
      if (oldest.done) break;
      entries.delete(oldest.value);
    }
  }

  return {
    now,

    create({ accessToken, accessTokenExpiresAt }) {
      const issuedAt = now();
      if (accessTokenExpiresAt <= issuedAt) {
        throw new Error('Refusing to create a session for an already expired access token');
      }
      // A session may never outlive the access token it depends on: there is no refresh grant here,
      // so an expired token can only be replaced by signing in again.
      const expiresAt = Math.min(issuedAt + maxSessionSeconds * 1000, accessTokenExpiresAt);
      makeRoom(sessions, MAX_LIVE_SESSIONS);
      const session: WebSession = {
        id: opaqueToken(),
        accessToken,
        accessTokenExpiresAt,
        expiresAt,
        csrfToken: opaqueToken(),
        subject: null,
        scope: null,
        approvalKeys: new Map(),
        receiptReferences: new Map(),
      };
      sessions.set(session.id, session);
      return session;
    },

    get: live,

    destroy(id) {
      sessions.delete(id);
    },

    size() {
      return sessions.size;
    },

    pendingSize() {
      return pendingLogins.size;
    },

    approvalKey(sessionId, quoteId, quoteVersion) {
      const session = required(sessionId);
      const key = `${quoteId}:${quoteVersion}`;
      // One idempotency key per quote version: a transport retry reuses it, and a re-quote cannot.
      const existing = session.approvalKeys.get(key);
      if (existing) return existing;
      const generated = `pc-web-${opaqueToken().slice(0, 32)}`;
      session.approvalKeys.set(key, generated);
      return generated;
    },

    receiptReference(sessionId, intentId, lines) {
      const session = required(sessionId);
      const key = receiptKey(intentId, lines);
      const existing = session.receiptReferences.get(key);
      if (existing) return existing;
      const generated = `pc-web-rcpt-${opaqueToken().slice(0, 32)}`;
      session.receiptReferences.set(key, generated);
      return generated;
    },

    createPendingLogin(pending) {
      // Unauthenticated callers reach this through GET /auth/login, so it is the one allocation a
      // stranger controls. Bounded before the insert, never after.
      makeRoom(pendingLogins, MAX_PENDING_LOGINS);
      const handle = opaqueToken();
      pendingLogins.set(handle, { ...pending, expiresAt: now() + PENDING_LOGIN_SECONDS * 1000 });
      return handle;
    },

    takePendingLogin(handle) {
      const pending = pendingLogins.get(handle);
      if (!pending) return null;
      pendingLogins.delete(handle);
      if (now() >= pending.expiresAt) return null;
      return { state: pending.state, codeVerifier: pending.codeVerifier };
    },
  };
}
