import type { Context, MiddlewareHandler } from "hono";

/**
 * Robust CORS & Preflight Manager for x402 payment APIs.
 * Automatically handles browser preflight requests and exposes essential
 * x402 payment negotiation headers (payment-required, payment-response, idempotency-key).
 */

export interface CorsOptions {
  /**
   * Allowed origin(s). Can be "*" (wildcard), an array of allowed origins, or a predicate function.
   * Default: "*"
   */
  origin?: string | string[] | ((origin: string) => boolean);
  /** Allowed HTTP methods. Default: ["GET", "POST", "PUT", "DELETE", "OPTIONS"] */
  allowMethods?: string[];
  /** Allowed HTTP headers. Default includes standard and x402 payment headers. */
  allowHeaders?: string[];
  /** Headers exposed to the browser JavaScript context. Default includes x402 headers. */
  exposeHeaders?: string[];
  /** Preflight cache duration in seconds (Access-Control-Max-Age). Default: 86400 (24h) */
  maxAge?: number;
  /** Whether to allow credentials (cookies, authorization headers). Default: false */
  credentials?: boolean;
}

export const DEFAULT_ALLOWED_METHODS = ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"];

export const DEFAULT_ALLOWED_HEADERS = [
  "content-type",
  "authorization",
  "payment-signature",
  "x-payment",
  "idempotency-key",
  "x-request-id",
];

export const DEFAULT_EXPOSED_HEADERS = [
  "payment-required",
  "payment-response",
  "x-payment-response",
  "idempotent-replayed",
  "x-request-id",
  "x-response-time",
];

/**
 * Creates a CORS middleware handler for Hono applications.
 */
export function createCorsMiddleware(options: CorsOptions = {}): MiddlewareHandler {
  const originOption = options.origin ?? "*";
  const allowMethods = options.allowMethods ?? DEFAULT_ALLOWED_METHODS;
  const allowHeaders = options.allowHeaders ?? DEFAULT_ALLOWED_HEADERS;
  const exposeHeaders = options.exposeHeaders ?? DEFAULT_EXPOSED_HEADERS;
  const maxAge = options.maxAge ?? 86400;
  const credentials = options.credentials ?? false;

  function resolveAllowedOrigin(requestOrigin: string | undefined): string | null {
    if (!requestOrigin) return "*";
    if (originOption === "*") return "*";

    if (Array.isArray(originOption)) {
      return originOption.includes(requestOrigin) ? requestOrigin : null;
    }

    if (typeof originOption === "function") {
      return originOption(requestOrigin) ? requestOrigin : null;
    }

    return originOption === requestOrigin ? requestOrigin : null;
  }

  return async (c: Context, next: () => Promise<Response | void>) => {
    const requestOrigin = c.req.header("origin");
    const allowedOrigin = resolveAllowedOrigin(requestOrigin);

    // If preflight OPTIONS request
    if (c.req.method === "OPTIONS") {
      if (!allowedOrigin) {
        return c.text("CORS origin not allowed", 403);
      }

      const headers = new Headers();
      headers.set("Access-Control-Allow-Origin", allowedOrigin);
      headers.set("Access-Control-Allow-Methods", allowMethods.join(", "));
      headers.set("Access-Control-Allow-Headers", allowHeaders.join(", "));
      headers.set("Access-Control-Max-Age", String(maxAge));

      if (credentials) {
        headers.set("Access-Control-Allow-Credentials", "true");
      }

      return new Response(null, {
        status: 204,
        headers,
      });
    }

    await next();

    // Inject headers into response
    if (allowedOrigin) {
      c.res.headers.set("Access-Control-Allow-Origin", allowedOrigin);
      c.res.headers.set("Access-Control-Expose-Headers", exposeHeaders.join(", "));

      if (credentials) {
        c.res.headers.set("Access-Control-Allow-Credentials", "true");
      }
    }
  };
}
