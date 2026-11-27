import { describe, expect, test } from "bun:test";
import type { FacilitatorClient } from "@x402/core/server";
import { createApp } from "../src/index.js";
import {
  AdaptiveRateLimiter,
  type RateLimiterOptions,
} from "../src/rate-limiter.js";
import { PAYER, signature, supported, testConfig } from "./helpers.js";

function rateLimitedApp(options: {
  rateLimiter: RateLimiterOptions;
  settles?: boolean;
  upstream?: (request: Request) => Promise<Response>;
}) {
  const events: string[] = [];
  const config = testConfig();
  const facilitator: FacilitatorClient = {
    getSupported: async () => supported,
    verify: async () => {
      events.push("verify");
      return { isValid: true, payer: PAYER };
    },
    settle: async () => {
      events.push("settle");
      return {
        success: options.settles !== false,
        transaction: options.settles === false ? "" : "0xmock-tx",
        network: config.chain.network,
        payer: PAYER,
        ...(options.settles === false
          ? { errorReason: "settlement_failed" }
          : {}),
      };
    },
  };
  const app = createApp(config, {
    rateLimiter: options.rateLimiter,
    facilitator,
    fetchUpstream: async (request) => {
      events.push("upstream");
      return options.upstream
        ? options.upstream(request)
        : Response.json({ result: "protected response" });
    },
  });
  return { app, events };
}

describe("AdaptiveRateLimiter header preservation and boundary guards", () => {
  test("preserves X-RateLimit headers across 402, paid proxy 200, idempotent replay, upstream errors, and settlement refusal", async () => {
    const ok = rateLimitedApp({
      rateLimiter: { capacity: 5, refillRatePerSec: 1 },
    });

    // 1. Missing payment -> 402 with rate limit headers and no verify/upstream/settle
    const r402 = await ok.app.request("/v1/echo");
    expect(r402.status).toBe(402);
    expect(r402.headers.get("x-ratelimit-limit")).toBe("5");
    expect(r402.headers.get("x-ratelimit-remaining")).toBe("4");
    expect(r402.headers.get("x-ratelimit-reset")).toBeDefined();
    expect(r402.headers.get("cache-control")).toBe("no-store");
    expect(ok.events).toEqual([]);

    // /healthz bypasses /v1/* limiter
    const health = await ok.app.request("/healthz");
    expect(health.status).toBe(200);
    expect(health.headers.get("x-ratelimit-limit")).toBeNull();

    // 2. Paid 200 proxy response retains rate limit headers
    const sig = await signature(ok.app);
    const paid = await ok.app.request("/v1/echo", {
      headers: {
        "payment-signature": sig,
        "idempotency-key": "rate-header-replay-1",
      },
    });
    expect(paid.status).toBe(200);
    expect(paid.headers.has("payment-response")).toBe(true);
    expect(paid.headers.get("x-ratelimit-limit")).toBe("5");
    expect(paid.headers.get("x-ratelimit-remaining")).toBe("2");
    expect(paid.headers.get("x-ratelimit-reset")).toBeDefined();
    expect(paid.headers.get("cache-control")).toBe("no-store");
    expect(ok.events).toEqual(["verify", "upstream", "settle"]);

    // 3. Cached idempotent replay retains updated rate limit headers
    const replay = await ok.app.request("/v1/echo", {
      headers: {
        "payment-signature": sig,
        "idempotency-key": "rate-header-replay-1",
      },
    });
    expect(replay.status).toBe(200);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    expect(replay.headers.get("x-ratelimit-limit")).toBe("5");
    expect(replay.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(ok.events).toEqual(["verify", "upstream", "settle"]);

    // 4. Exhausting remaining capacity returns 429 before verification
    expect((await ok.app.request("/v1/echo")).status).toBe(402);
    const limited = await ok.app.request("/v1/echo");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeDefined();
    expect(limited.headers.get("x-ratelimit-limit")).toBe("5");
    expect(limited.headers.get("x-ratelimit-remaining")).toBe("0");
    expect(ok.events).toEqual(["verify", "upstream", "settle"]);

    // 5. Upstream 500 failure retains headers without settlement
    const upstreamFail = rateLimitedApp({
      rateLimiter: { capacity: 3, refillRatePerSec: 1 },
      upstream: async () => new Response("upstream down", { status: 500 }),
    });
    const sigFail = await signature(upstreamFail.app);
    const failRes = await upstreamFail.app.request("/v1/echo", {
      headers: { "payment-signature": sigFail },
    });
    expect(failRes.status).toBe(500);
    expect(failRes.headers.get("x-ratelimit-limit")).toBe("3");
    expect(failRes.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(upstreamFail.events).toEqual(["verify", "upstream"]);

    // 6. Settlement refusal retains headers and withholds upstream body
    const settleFail = rateLimitedApp({
      rateLimiter: { capacity: 3, refillRatePerSec: 1 },
      settles: false,
    });
    const sigSettleFail = await signature(settleFail.app);
    const settleRes = await settleFail.app.request("/v1/echo", {
      headers: { "payment-signature": sigSettleFail },
    });
    expect(settleRes.status).toBe(402);
    expect(settleRes.headers.get("x-ratelimit-limit")).toBe("3");
    expect(settleRes.headers.get("x-ratelimit-remaining")).toBe("1");
    expect(settleFail.events).toEqual(["verify", "upstream", "settle"]);
  });

  test("rejects unsafe capacities, invalid cleanupIntervalMs, and non-finite timestamps", () => {
    for (const capacity of [2 ** 53, Number.MAX_VALUE]) {
      expect(
        () => new AdaptiveRateLimiter({ capacity, refillRatePerSec: 1 }),
      ).toThrow("safe token accounting range");
    }

    const safeMax = new AdaptiveRateLimiter({
      capacity: Number.MAX_SAFE_INTEGER,
      refillRatePerSec: 1,
    });
    expect(safeMax.consume("client", 1, 0).remaining).toBe(
      Number.MAX_SAFE_INTEGER - 1,
    );
    expect(safeMax.consume("client", 1, 0).remaining).toBe(
      Number.MAX_SAFE_INTEGER - 2,
    );

    for (const cleanupIntervalMs of [0, -100, NaN, Infinity, -Infinity]) {
      expect(
        () =>
          new AdaptiveRateLimiter({
            capacity: 2,
            refillRatePerSec: 1,
            cleanupIntervalMs,
          }),
      ).toThrow("cleanupIntervalMs");
    }

    const limiter = new AdaptiveRateLimiter({
      capacity: 1,
      refillRatePerSec: 0.1,
      cleanupIntervalMs: 1000,
    });
    expect(limiter.consume("agent", 1, 10_000).allowed).toBe(true);
    for (const badTime of [NaN, Infinity, -Infinity]) {
      expect(() => limiter.consume("agent", 1, badTime)).toThrow("timestamp");
    }
    // Clock rollback must not roll back lastAccessMs and trigger premature eviction.
    expect(limiter.consume("agent", 1, 0).allowed).toBe(false);
    expect(limiter.consume("other", 1, 12_000).allowed).toBe(true);
    expect(limiter.activeClientCount).toBe(2);
    expect(limiter.consume("agent", 1, 12_000).allowed).toBe(false);
  });
});
