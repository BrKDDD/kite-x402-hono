import type { MiddlewareHandler } from 'hono';

export interface StructuredErrorLoggerOptions {
  includeStack?: boolean;
}

export function structuredErrorLogger(options: StructuredErrorLoggerOptions = {}): MiddlewareHandler {
  return async (c, next) => {
    const traceId = c.req.header('x-trace-id') || `tr-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`;
    c.header('x-trace-id', traceId);

    try {
      await next();
    } catch (err: any) {
      const status = err.status || 500;
      const responsePayload = {
        success: false,
        traceId,
        timestamp: new Date().toISOString(),
        error: {
          code: err.code || 'INTERNAL_SERVER_ERROR',
          message: err.message || 'An unexpected error occurred during request processing',
          ...(options.includeStack && { stack: err.stack }),
        },
      };

      console.error(`[Trace ${traceId}] Error ${status}:`, err.message);
      return c.json(responsePayload, status);
    }
  };
}

export default structuredErrorLogger;
