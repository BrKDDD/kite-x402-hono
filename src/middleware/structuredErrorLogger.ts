import type { ErrorHandler } from "hono";

export interface StructuredErrorLoggerOptions {
  /** Include stack traces in server logs only. Logs may contain sensitive data. */
  includeStack?: boolean;
  sink?: (line: string) => void;
}

const validId = /^[A-Za-z0-9._~-]{1,128}$/;

/** Register with app.onError(); Hono handles exceptions before next() returns. */
export function structuredErrorLogger(
  options: StructuredErrorLoggerOptions = {},
): ErrorHandler {
  const sink = options.sink ?? console.error;
  return (err, c) => {
    const candidate = c.req.header("x-request-id");
    const requestId =
      candidate && validId.test(candidate) ? candidate : crypto.randomUUID();
    // Arbitrary error.status/code/message values are never public response data.
    const timestamp = new Date().toISOString();
    try {
      sink(
        JSON.stringify({
          level: "error",
          timestamp,
          requestId,
          status: 500,
          error: "internal_error",
          ...(options.includeStack && { stack: err.stack }),
        }),
      );
    } catch {
      // A broken logging sink must not prevent the error response.
    }
    return c.json({ error: "internal_error", requestId }, 500, {
      "x-request-id": requestId,
      "cache-control": "no-store",
    });
  };
}

export default structuredErrorLogger;
