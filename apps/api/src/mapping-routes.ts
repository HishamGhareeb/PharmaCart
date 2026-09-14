import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { Pool } from 'pg';

import type { VerifiedAccessToken } from '../../../packages/auth/src/verify-access-token.ts';
import type { TokenVerifier } from './tenant-api.ts';
import {
  bindNeedMapping,
  listMappingCandidates,
  MappingError,
  type BindMappingCommand,
} from '../../../packages/db/src/mapping.ts';
import {
  MembershipAccessDeniedError,
  withTransaction,
  type RuntimeClient,
  type TenantContext,
} from '../../../packages/db/src/runtime.ts';
import { ApiError } from './errors.ts';

/*
 * Explicit human pack-mapping routes. buildTenantApi registers this module, so the module keeps its
 * own copy of the token and selector boundary rather than importing those values back from
 * tenant-api.ts, which would close a runtime import cycle. TokenVerifier is imported as a type only,
 * which erases on load and therefore adds no module edge.
 */

const UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const uuid = new RegExp(UUID_PATTERN);

/** Every accepted field is declared: unknown properties and loose types are refused outright. */
const mappingCommandSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['needVersion', 'productId'],
  properties: {
    needVersion: { type: 'integer', minimum: 1, maximum: 2147483647 },
    productId: { type: 'string', pattern: UUID_PATTERN },
    // Only required when the need carries no authoritative unit metadata, and then it must equal the
    // selected catalogue sale unit exactly.
    suppliedUnit: { type: 'string', minLength: 1, maxLength: 32 },
  },
} as const;

function selector(value: unknown): string {
  if (typeof value !== 'string' || !uuid.test(value)) {
    throw new ApiError(400, 'INVALID_REQUEST', 'A canonical UUID selector is required.');
  }
  return value;
}

async function authenticate(request: FastifyRequest, verifier: TokenVerifier): Promise<VerifiedAccessToken> {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ') || header.length > 16400) {
    throw new ApiError(401, 'UNAUTHENTICATED', 'A valid access token is required.');
  }
  try {
    return await verifier.verifyAccessToken(header.slice(7));
  } catch {
    throw new ApiError(401, 'UNAUTHENTICATED', 'A valid access token is required.');
  }
}

/** A refusal message may describe the mapping decision, never the resource behind it. */
function mappingMessage(status: number): string {
  if (status === 404) return 'The requested resource was not found.';
  if (status === 403) return 'The selected scope is not permitted.';
  return 'The mapping request could not be completed.';
}

export function registerMappingRoutes(app: FastifyInstance, pool: Pool, verifier: TokenVerifier): void {
  async function member<T>(
    request: FastifyRequest,
    operation: (client: RuntimeClient, context: TenantContext) => Promise<T>,
  ): Promise<T> {
    const identity = await authenticate(request, verifier);
    try {
      return await withTransaction(
        pool,
        identity.subject,
        selector(request.headers['x-organisation-id']),
        selector(request.headers['x-branch-id']),
        operation,
      );
    } catch (error) {
      if (error instanceof MembershipAccessDeniedError) {
        throw new ApiError(403, 'FORBIDDEN', 'The selected scope is not permitted.');
      }
      if (error instanceof MappingError) throw new ApiError(error.status, error.code, mappingMessage(error.status));
      throw error;
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

