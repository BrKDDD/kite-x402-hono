import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { corsAllowlistValidator } from "../src/middleware/corsAllowlistValidator.js";

function app() {
  const app = new Hono();
  app.use(
    "*",
    corsAllowlistValidator({ allowedDomains: ["https://client.example"] }),
  );
  // 这里只模拟支付门禁；预检获准不等于付款验证或链上结算成功。
  app.all("/v1/echo", (c) =>
    c.json({ error: "payment_required" }, 402, {
      "Payment-Required": "local-fixture",
    }),
  );
  return app;
}

describe("opt-in CORS permits supported legacy payment clients", () => {
  test.each(["X-PAYMENT", "x-payment", "content-type, X-Payment"])(
    "allows preflight headers %s",
    async (headers) => {
      const response = await app().request("/v1/echo", {
        method: "OPTIONS",
        headers: {
          origin: "https://client.example",
          "access-control-request-method": "POST",
          "access-control-request-headers": headers,
        },
      });
      expect(response.status).toBe(204);
      expect(
        response.headers.get("access-control-allow-headers")?.toLowerCase(),
      ).toContain("x-payment");
    },
  );

  test("an untrusted origin or unrelated requested header is still denied", async () => {
    for (const [origin, requested] of [
      ["https://other.example", "x-payment"],
      ["https://client.example", "x-payment, x-admin"],
    ]) {
      const response = await app().request("/v1/echo", {
        method: "OPTIONS",
        headers: {
          origin: origin!,
          "access-control-request-method": "POST",
          "access-control-request-headers": requested!,
        },
      });
      expect(response.status).toBe(403);
    }
  });

  test("ordinary OPTIONS and unpaid requests still reach the payment gate", async () => {
    for (const method of ["OPTIONS", "GET"]) {
      const response = await app().request("/v1/echo", {
        method,
        headers: { origin: "https://client.example" },
      });
      expect(response.status).toBe(402);
    }
  });
});
