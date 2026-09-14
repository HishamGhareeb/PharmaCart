import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import {
  MAX_CURSOR_LENGTH,
  MAX_STATUS_LENGTH,
  ListError,
  bindListQuery,
  listNeeds,
  listOrders,
  parseListQuery,
  requirePharmacyPrincipal,
  type ListKind,
  type ListPrincipal,
  type ListQuery,
  type NeedSummary,
  type OrderSummary,
  type Page,
} from '../../../packages/db/src/lists.ts';
import {
  MembershipAccessDeniedError,
  type MembershipRole,
  type RuntimeClient,
  type TenantContext,
} from '../../../packages/db/src/runtime.ts';
import { ApiError } from './errors.ts';
import { poolScope, type TenantScope, type TokenVerifier } from './request-auth.ts';

/**
 * Tenant-scoped list reads: `GET /v1/needs` and `GET /v1/orders`.
 *
 * `buildTenantApi` registers this module; the operations are described by `listNeeds` and `listOrders`
 * in packages/contracts/openapi.json. See docs/testing/api-registration-openapi.md.
 *
 * `GET /v1/scopes` is deliberately absent. Enumerating a user's memberships needs a read that is not
 * yet scoped by `app.organisation_id`/`app.branch_id`, which the existing
 * `pharmacart_active_membership(text, uuid, uuid)` cannot serve because it requires the very
 * organisation and branch the caller is trying to discover. Supplying it would mean either a new
 * SECURITY DEFINER function (a migration this lane does not own) or a broader membership policy.
 * It is recorded as pending instead.
 */

/**
 * The seam between a route and a tenant transaction. The default implementation authenticates the
 * bearer token, validates the tenant selectors and runs the operation inside `withTransaction`, so
 * row level security is established before a single list row is read. Tests inject their own.
 */
export type ListScope = TenantScope;

/**
 * Roles admitted to either list. OPEN DECISION for human review: lists.ts leaves the role inside a
 * pharmacy undecided. The reviewed PostgreSQL evidence (packages/db/test/lists.test.ts) lists as a
 * pharmacy_owner and as a purchaser, so both are admitted; nothing encodes receiver or support, so
 * they are refused until a person decides. This is the existing quote and mapping-read role set.
 */
const LIST_ROLES: readonly MembershipRole[] = ['pharmacy_owner', 'purchaser'];

/** The refusal is the membership refusal verbatim, so it discloses neither the role nor the reason. */
function requireListRole(context: TenantContext): void {
  if (!LIST_ROLES.includes(context.role)) throw new ApiError(403, 'FORBIDDEN', 'The selected scope is not permitted.');
}

export type ListRepository = Readonly<{
  listNeeds(client: RuntimeClient, principal: ListPrincipal, query: ListQuery): Promise<Page<NeedSummary>>;
  listOrders(client: RuntimeClient, principal: ListPrincipal, query: ListQuery): Promise<Page<OrderSummary>>;
}>;

export type ListRoutesOptions = Readonly<{ scope?: ListScope; repository?: ListRepository }>;

/**
 * Strict query contract. Unknown keys, repeated keys (which arrive as arrays) and oversized values
 * are refused here; `parseListQuery` then decides the semantics. Nothing is coerced or defaulted by
 * the schema itself, matching the ajv options in `buildApp`.
 */
const listQuerySchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    limit: { type: 'string', maxLength: 3 },
    status: { type: 'string', maxLength: MAX_STATUS_LENGTH },
    cursor: { type: 'string', maxLength: MAX_CURSOR_LENGTH },
  },
} as const;

function asApiError(error: unknown): unknown {
  // 5xx ListErrors are internal invariants; they fall through to the stable redacted handler.
  if (error instanceof ListError && error.status < 500) return new ApiError(error.status, error.code, error.message);
  if (error instanceof MembershipAccessDeniedError) return new ApiError(403, 'FORBIDDEN', 'The selected scope is not permitted.');
  return error;
}

export function registerListRoutes(
  app: FastifyInstance,
  pool: Pool,
  verifier: TokenVerifier,
  options: ListRoutesOptions = {},
): void {
  const scope = options.scope ?? poolScope(pool, verifier);
  const repository = options.repository ?? { listNeeds, listOrders };

  async function list(kind: ListKind, request: FastifyRequest): Promise<Page<NeedSummary> | Page<OrderSummary>> {
    try {
      // Purely syntactic, so it costs no connection and needs no identity. Anything that depends on
      // *who* is asking - the cursor's scope, the organisation kind - waits for the scope below.
      const parsed = parseListQuery(kind, request.query as unknown);

      return await scope<Page<NeedSummary> | Page<OrderSummary>>(request, (client, context) => {
        // A list is a pharmacy-side read; refuse the wrong side of the market before anything else.
        requirePharmacyPrincipal(context);
        requireListRole(context);
        // Authoritative: the cursor is bound to the membership the transaction resolved, not to the
        // header the caller sent, so a cursor can never move a request into another scope. It is
        // judged only here, so an unauthenticated caller learns nothing about a cursor's scope.
        const query = bindListQuery(parsed, kind, context);
        return kind === 'needs'
          ? repository.listNeeds(client, context, query)
          : repository.listOrders(client, context, query);
      });
    } catch (error) {
      throw asApiError(error);
    }
  }

  for (const kind of ['needs', 'orders'] as const) {
    app.get(`/v1/${kind}`, { schema: { querystring: listQuerySchema } }, async (request, reply) => {
      // Tenant-scoped, authenticated data: never store it in a shared or intermediary cache.
      void reply.header('cache-control', 'no-store');
      return list(kind, request);
    });
  }
}
