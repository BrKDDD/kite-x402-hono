import type { MiddlewareHandler } from 'hono';

export interface RateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  keyGenerator?: (c: any) => string;
}

export function adaptiveRateLimiter(options: RateLimiterOptions = {}): MiddlewareHandler {
  const windowMs = options.windowMs || 60000;
  const maxRequests = options.maxRequests || 120;
  const hitLog = new Map<string, number[]>();

  return async (c, next) => {
    const now = Date.now();
    const clientKey = options.keyGenerator
      ? options.keyGenerator(c)
      : c.req.header('x-forwarded-for') || c.req.header('cf-connecting-ip') || 'anonymous-client';

    let timestamps = hitLog.get(clientKey) || [];
    timestamps = timestamps.filter((t) => now - t < windowMs);

    if (timestamps.length >= maxRequests) {
      c.header('X-RateLimit-Limit', maxRequests.toString());
      c.header('X-RateLimit-Remaining', '0');
      c.header('X-RateLimit-Reset', Math.ceil((now + windowMs) / 1000).toString());
      return c.json(
        {
          error: 'Too Many Requests',
          message: `Exceeded request budget of ${maxRequests} requests per ${windowMs / 1000}s`,
        },
        429
      );
    }

    timestamps.push(now);
    hitLog.set(clientKey, timestamps);

    c.header('X-RateLimit-Limit', maxRequests.toString());
    c.header('X-RateLimit-Remaining', (maxRequests - timestamps.length).toString());

    await next();
  };
}

export default adaptiveRateLimiter;
