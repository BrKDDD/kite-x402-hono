import { describe, expect, test } from "bun:test";
import type { PaymentRequired } from "@x402/core/types";
import { harness, signature, supported } from "./helpers.js";

describe("real x402 middleware with a simulated facilitator", () => {
  test.each(["mainnet", "testnet"])(
    "unpaid %s challenge has correct chain, amount and domain",
    async (network) => {
      const { app, config, events } = harness({
        env: { KITE_NETWORK: network },
      });
      const response = await app.request("/v1/echo");
      expect(response.status).toBe(402);
      const data = JSON.parse(
        Buffer.from(
          response.headers.get("payment-required")!,
          "base64",
        ).toString(),
      ) as PaymentRequired;
      expect(data.x402Version).toBe(2);
      expect(data.accepts[0]).toMatchObject({
        network: config.chain.network,
        asset: config.chain.asset,
        amount: network === "mainnet" ? "1000" : "1000000000000000",
        payTo: config.payTo,
        extra: { name: config.chain.name, version: config.chain.version },
      });
      expect(events).toEqual([]);
    },
  );
  test("health and unknown routes do not depend on facilitator", async () => {
    const { app } = harness({
      facilitator: {
        getSupported: async () => {
          throw new Error("offline");
        },
      },
    });
    expect((await app.request("/healthz")).status).toBe(200);
    expect((await app.request("/not-a-paid-route")).status).toBe(404);
    expect((await app.request("/v1/echo")).status).toBe(503);
  });
  test("initialization recovers after transient failure", async () => {
    let calls = 0;
    const { app } = harness({
      facilitator: {
        getSupported: async () => {
          if (++calls === 1) throw new Error("offline");
          return supported;
        },
      },
    });
    expect((await app.request("/v1/echo")).status).toBe(503);
    expect((await app.request("/v1/echo")).status).toBe(402);
  });
  test("unsupported network fails closed", async () => {
    const { app, events } = harness({
      facilitator: {
        getSupported: async () => ({ kinds: [], extensions: [], signers: {} }),
      },
    });
    expect((await app.request("/v1/echo")).status).toBe(503);
    expect(events).toEqual([]);
  });
  test("malformed signature never reaches upstream", async () => {
    const { app, events } = harness();
    const response = await app.request("/v1/echo", {
      headers: { "payment-signature": "not-base64-json" },
    });
    expect(response.status).toBe(402);
    expect(events).toEqual([]);
  });
  test("invalid payment is verified but never proxied or settled", async () => {
    const { app, events } = harness({ valid: false });
    const response = await app.request("/v1/echo", {
      headers: { "payment-signature": await signature(app) },
    });
    expect(response.status).toBe(402);
    expect(events).toEqual(["verify"]);
  });
  test("successful payment executes verify -> upstream -> settle", async () => {
    const { app, events } = harness();
    const response = await app.request("/v1/echo", {
      headers: { "payment-signature": await signature(app) },
    });
    expect(response.status).toBe(200);
    expect(events).toEqual(["verify", "upstream", "settle"]);
    expect(await response.json()).toEqual({ result: "protected response" });
    const receipt = JSON.parse(
      Buffer.from(
        response.headers.get("payment-response")!,
        "base64",
      ).toString(),
    );
    expect(receipt.success).toBe(true);
    expect(receipt.transaction).toBe("0xmock-transaction-not-on-chain");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
  test.each([400, 401, 404, 429, 500, 503])(
    "upstream %s is returned without settlement",
    async (status) => {
      const { app, events } = harness({
        upstream: async () => Response.json({ error: "upstream" }, { status }),
      });
      const response = await app.request("/v1/echo", {
        headers: { "payment-signature": await signature(app) },
      });
      expect(response.status).toBe(status);
      expect(events).toEqual(["verify", "upstream"]);
      expect(response.headers.get("payment-response")).toBeNull();
    },
  );
  test("settlement refusal withholds protected data", async () => {
    const { app, events } = harness({ settles: false });
    const response = await app.request("/v1/echo", {
      headers: { "payment-signature": await signature(app) },
    });
    expect(response.status).toBe(402);
    expect(await response.text()).not.toContain("protected response");
    expect(events).toEqual(["verify", "upstream", "settle"]);
  });
  test("connection failure becomes generic 502 without settlement or secret disclosure", async () => {
    const { app, events } = harness({
      upstream: async () => {
        throw new Error("connection failed with secret=abc");
      },
    });
    const response = await app.request("/v1/echo", {
      headers: { "payment-signature": await signature(app) },
    });
    expect(response.status).toBe(502);
    expect(await response.text()).not.toContain("secret");
    expect(events).toEqual(["verify", "upstream"]);
  });
  test("upstream timeout does not settle", async () => {
    const { app, events } = harness({
      env: { UPSTREAM_TIMEOUT_MS: "10" },
      upstream: (request) =>
        new Promise((_, reject) => {
          request.signal.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    });
    const response = await app.request("/v1/echo", {
      headers: { "payment-signature": await signature(app) },
    });
    expect(response.status).toBe(504);
    expect(events).toEqual(["verify", "upstream"]);
  });
  test("mismatched network or amount is rejected before verification", async () => {
    for (const change of [{ network: "eip155:1" }, { amount: "1" }]) {
      const { app, events } = harness();
      const payload = JSON.parse(
        Buffer.from(await signature(app), "base64").toString(),
      );
      Object.assign(payload.accepted, change);
      const result = await app.request("/v1/echo", {
        headers: {
          "payment-signature": Buffer.from(JSON.stringify(payload)).toString(
            "base64",
          ),
        },
      });
      expect(result.status).toBe(402);
      expect(events).toEqual([]);
    }
  });
  test.each(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"])(
    "%s route cannot bypass payment",
    async (method) => {
      const { app, events } = harness();
      expect((await app.request("/v1/echo", { method })).status).toBe(402);
      expect(events).toEqual([]);
    },
  );
});
