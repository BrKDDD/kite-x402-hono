import type { MiddlewareHandler } from "hono";
import { isSerializedOrigin } from "./cors-preflight-guard.js";

export interface CorsAllowlistOptions {
  /** Exact serialized origins or full-origin regex matches. */
  allowedDomains: (string | RegExp)[];
  credentials?: boolean;
}

/** Explicit opt-in CORS policy; use instead of another CORS middleware. */
export function corsAllowlistValidator(
  options: CorsAllowlistOptions,
): MiddlewareHandler {
  const patterns = options.allowedDomains.map((p) => {
    if (typeof p === "string") {
      if (!isSerializedOrigin(p)) throw new Error("Invalid allowed origin");
      return p;
    }
    return new RegExp(p.source, p.flags.replace(/[gy]/g, ""));
  });
  const credentials = options.credentials === true;
  const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
  const headers = [
    "content-type",
    "authorization",
    "payment-signature",
    // 网关兼容旧版付款头，浏览器预检也须允许同一协议入口。
    "x-payment",
    "idempotency-key",
    "x-request-id",
  ];
  return async (c, next) => {
    const origin = c.req.header("origin");
    const requestedMethod = c.req.header("access-control-request-method");
    const preflight =
      c.req.method === "OPTIONS" && !!origin && !!requestedMethod;
    const allowed =
      !!origin &&
      isSerializedOrigin(origin) &&
      patterns.some((p) => {
        if (typeof p === "string") return p === origin;
        const match = p.exec(origin);
        return match !== null && match.index === 0 && match[0] === origin;
      });
    if (preflight) {
      const requestedHeaders = c.req.header("access-control-request-headers");
      const validHeaders =
        requestedHeaders === undefined ||
        requestedHeaders
          .split(",")
          .every((h) => headers.includes(h.trim().toLowerCase()));
      const vary =
        "Origin, Access-Control-Request-Method, Access-Control-Request-Headers";
      if (!allowed || !methods.includes(requestedMethod!) || !validHeaders)
        return c.json({ error: "cors_preflight_denied" }, 403, {
          Vary: vary,
          "Cache-Control": "no-store",
        });
      return new Response(null, {
        status: 204,
        headers: {
          Vary: vary,
          "Cache-Control": "no-store",
          "Access-Control-Allow-Origin": origin!,
          "Access-Control-Allow-Methods": methods.join(", "),
          "Access-Control-Allow-Headers": headers.join(", "),
          ...(credentials
            ? { "Access-Control-Allow-Credentials": "true" }
            : {}),
        },
      });
    }
    // Ordinary OPTIONS must reach payment/application middleware.
    await next();
    for (const key of [...c.res.headers.keys()])
      if (key.toLowerCase().startsWith("access-control-"))
        c.res.headers.delete(key);
    const vary = c.res.headers.get("vary");
    if (
      !vary
        ?.split(",")
        .some((v) => ["origin", "*"].includes(v.trim().toLowerCase()))
    )
      c.header("Vary", vary ? `${vary}, Origin` : "Origin");
    if (allowed) {
      c.header("Access-Control-Allow-Origin", origin!);
      if (credentials) c.header("Access-Control-Allow-Credentials", "true");
      c.header(
        "Access-Control-Expose-Headers",
        "Payment-Required, Payment-Response, Retry-After, X-Request-ID, X-Response-Time",
      );
    }
  };
}
export default corsAllowlistValidator;
