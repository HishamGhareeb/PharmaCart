import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import fastify, { type FastifyInstance } from 'fastify';

import { installErrorHandlers } from './errors.ts';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const DEFAULT_BODY_LIMIT = 1024 * 1024;

export type BuildAppOptions = Readonly<{
  bodyLimit?: number;
  logger?: boolean;
  register?: (app: FastifyInstance) => void;
}>;

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = fastify({
    logger: options.logger ?? false,
    bodyLimit: options.bodyLimit ?? DEFAULT_BODY_LIMIT,
    requestIdHeader: false,
    genReqId(request) {
      const candidate = request.headers['x-correlation-id'];
      return typeof candidate === 'string' && UUID_PATTERN.test(candidate) ? candidate : randomUUID();
    },
    ajv: {
      customOptions: {
        coerceTypes: false,
        removeAdditional: false,
        useDefaults: false,
      },
    },
  });

  app.addHook('onRequest', (request, reply, done) => {
    void reply.header('x-correlation-id', request.id);
    done();
  });

  installErrorHandlers(app);

  app.get('/health', async () => ({ status: 'ok' }));
  const openapi = JSON.parse(readFileSync(new URL('../../../packages/contracts/openapi.json', import.meta.url), 'utf8'));
  app.get('/openapi.json', async () => openapi);
  options.register?.(app);

  return app;
}
