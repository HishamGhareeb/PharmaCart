import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

export type ErrorCode =
  | 'INTERNAL_ERROR'
  | 'INVALID_JSON'
  | 'INVALID_REQUEST'
  | 'NOT_FOUND'
  | 'PAYLOAD_TOO_LARGE'
  | 'UNSUPPORTED_MEDIA_TYPE';

type ErrorDefinition = Readonly<{
  statusCode: number;
  code: ErrorCode;
  message: string;
}>;

const INTERNAL_ERROR: ErrorDefinition = {
  statusCode: 500,
  code: 'INTERNAL_ERROR',
  message: 'An unexpected error occurred.',
};

function classifyError(error: FastifyError): ErrorDefinition {
  if (error.code === 'FST_ERR_CTP_INVALID_JSON_BODY') {
    return {
      statusCode: 400,
      code: 'INVALID_JSON',
      message: 'The request body is not valid JSON.',
    };
  }

  if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
    return {
      statusCode: 413,
      code: 'PAYLOAD_TOO_LARGE',
      message: 'The request body is too large.',
    };
  }

  if (error.code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE') {
    return {
      statusCode: 415,
      code: 'UNSUPPORTED_MEDIA_TYPE',
      message: 'The request media type is not supported.',
    };
  }

  if (error.validation !== undefined) {
    return {
      statusCode: 400,
      code: 'INVALID_REQUEST',
      message: 'The request does not match the required contract.',
    };
  }

  return INTERNAL_ERROR;
}

function sendError(reply: FastifyReply, definition: ErrorDefinition, correlationId: string): void {
  void reply.status(definition.statusCode).send({
    error: {
      code: definition.code,
      message: definition.message,
      correlationId,
    },
  });
}

export function installErrorHandlers(app: FastifyInstance): void {
  app.setNotFoundHandler((request, reply) => {
    sendError(
      reply,
      {
        statusCode: 404,
        code: 'NOT_FOUND',
        message: 'The requested resource was not found.',
      },
      request.id,
    );
  });

  app.setErrorHandler((error: FastifyError, request: FastifyRequest, reply: FastifyReply) => {
    sendError(reply, classifyError(error), request.id);
  });
}
