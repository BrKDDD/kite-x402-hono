import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { createCorsMiddleware } from "../src/cors-manager.js";

describe("cors-manager", () => {
  test("handles OPTIONS preflight requests with default headers", async () => {
    const app = new Hono();
    app.use("*", createCorsMiddleware());
    app.get("/v1/data", (c) => c.text("ok"));

    const preflight = await app.request("/v1/data", {
      method: "OPTIONS",
      headers: {
        Origin: "https://agent-wallet.kite.ai",
      },
    });

    expect(preflight.status).toBe(204);
    expect(preflight.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(preflight.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(preflight.headers.get("Access-Control-Allow-Headers")).toContain("payment-signature");
  });

  test("enforces origin whitelist array", async () => {
    const app = new Hono();
    app.use(
      "*",
      createCorsMiddleware({
        origin: ["https://trusted.ai"],
      }),
    );
    app.get("/v1/data", (c) => c.text("ok"));

    const allowed = await app.request("/v1/data", {
      method: "OPTIONS",
      headers: {
        Origin: "https://trusted.ai",
      },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("https://trusted.ai");

    const denied = await app.request("/v1/data", {
      method: "OPTIONS",
      headers: {
        Origin: "https://evil.com",
      },
    });
    expect(denied.status).toBe(403);
  });

  test("exposes x402 response headers on actual response", async () => {
    const app = new Hono();
    app.use("*", createCorsMiddleware());
    app.get("/v1/data", (c) => {
      c.header("payment-response", "receipt_tx_123");
      return c.json({ result: "done" });
    });

    const res = await app.request("/v1/data", {
      headers: { Origin: "https://agent.kite.ai" },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(res.headers.get("Access-Control-Expose-Headers")).toContain("payment-response");
  });
});
