import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import { mappingCommandSchema } from '../../../packages/contracts/scripts/openapi.ts';
import {
  bindNeedMapping,
  listMappingCandidates,
  MappingError,
  type BindMappingCommand,
} from '../../../packages/db/src/mapping.ts';
import {
  MembershipAccessDeniedError,
  type RuntimeClient,
  type TenantContext,
} from '../../../packages/db/src/runtime.ts';
import { ApiError } from './errors.ts';
import { poolScope, selector, type TenantScope, type TokenVerifier } from './request-auth.ts';

/*
 * Explicit human pack-mapping routes: `GET /v1/needs/:id/mapping-candidates` and
 * `POST /v1/needs/:id/mapping`. buildTenantApi registers this module; the operations are described by
 * `getMappingCandidates` and `bindNeedMapping` in packages/contracts/openapi.json, whose request body
 * is the same `mappingCommandSchema` Fastify validates here.
 *
 * Role policy is the repository's, unchanged: pharmacy_owner or purchaser may read candidates
 * (assertMappingReadAllowed) and only pharmacy_owner may bind (assertMappingWriteAllowed).
 */

export type MappingRoutesOptions = Readonly<{ scope?: TenantScope }>;

/** A refusal message may describe the mapping decision, never the resource behind it. */
function mappingMessage(status: number): string {
  if (status === 404) return 'The requested resource was not found.';
  if (status === 403) return 'The selected scope is not permitted.';
  return 'The mapping request could not be completed.';
}

function asApiError(error: unknown): unknown {
  if (error instanceof MembershipAccessDeniedError) return new ApiError(403, 'FORBIDDEN', 'The selected scope is not permitted.');
  if (error instanceof MappingError) return new ApiError(error.status, error.code, mappingMessage(error.status));
  return error;
}

export function registerMappingRoutes(
  app: FastifyInstance,
  pool: Pool,
  verifier: TokenVerifier,
  options: MappingRoutesOptions = {},
): void {
  const scope = options.scope ?? poolScope(pool, verifier);

  async function member<T>(
    request: FastifyRequest,
    operation: (client: RuntimeClient, context: TenantContext) => Promise<T>,
  ): Promise<T> {
    try {
      return await scope(request, operation);
    } catch (error) {
      throw asApiError(error);
    }
  }

  app.get<{ Params: { id: string } }>('/v1/needs/:id/mapping-candidates', (request) =>
    member(request, (client, context) => listMappingCandidates(client, context, selector(request.params.id))));

  app.post<{ Params: { id: string }; Body: BindMappingCommand }>(
    '/v1/needs/:id/mapping',
    { schema: { body: mappingCommandSchema } },
    async (request, reply) => {
      const result = await member(request, (client, context) =>
        bindNeedMapping(client, context, selector(request.params.id), request.body));
      return reply.code(result.created ? 201 : 200).send(result.mapping);
    },
  );
}
