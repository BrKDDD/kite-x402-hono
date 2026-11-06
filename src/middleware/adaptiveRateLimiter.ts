import type { Context, MiddlewareHandler } from "hono";
import { SlidingWindowLimiter } from "./sliding-window-limiter.js";

export interface AdaptiveRateLimiterOptions {
  windowMs?: number;
  maxRequests?: number;
  /** Resolve a verified identity or trusted socket IP; forwarding headers are untrusted. */
  keyGenerator: (c: Context) => string;
}

/** Fixed-budget sliding window middleware (does not dynamically adapt budgets). */
export function adaptiveRateLimiter(
  options: AdaptiveRateLimiterOptions,
): MiddlewareHandler {
  if (typeof options?.keyGenerator !== "function")
    throw new Error("A trusted keyGenerator is required");
  const windowMs = options.windowMs ?? 60000;
  const maxRequests = options.maxRequests ?? 120;
  const limiter = new SlidingWindowLimiter(windowMs, maxRequests);
  return async (c, next) => {
    const key = options.keyGenerator(c);
    if (typeof key !== "string" || !key || key.length > 512)
      return c.json({ error: "Missing trusted client identity" }, 503);
    const result = limiter.check(key);
    c.header("X-RateLimit-Limit", String(maxRequests));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    if (!result.allowed) {
      c.header("Retry-After", String(result.resetSeconds));
      c.header(
        "X-RateLimit-Reset",
        String(Math.ceil(Date.now() / 1000) + result.resetSeconds),
      );
      return c.json({ error: "Too Many Requests" }, 429);
    }
    await next();
  };
}
export default adaptiveRateLimiter;
