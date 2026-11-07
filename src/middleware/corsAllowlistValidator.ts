import type { MiddlewareHandler } from 'hono';

export interface CorsAllowlistOptions {
  allowedDomains: (string | RegExp)[];
}

export function corsAllowlistValidator(options: CorsAllowlistOptions): MiddlewareHandler {
  return async (c, next) => {
    const origin = c.req.header('origin');
    if (origin) {
      const isAllowed = options.allowedDomains.some((pattern) =>
        typeof pattern === 'string' ? origin === pattern : pattern.test(origin)
      );

      if (isAllowed) {
        c.header('Access-Control-Allow-Origin', origin);
        c.header('Access-Control-Allow-Credentials', 'true');
        c.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        c.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-402-payment');
      }
    }

    if (c.req.method === 'OPTIONS') {
      return c.text('', 204);
    }

    await next();
  };
}

export default corsAllowlistValidator;
