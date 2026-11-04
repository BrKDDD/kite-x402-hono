import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createHash, createHmac } from "node:crypto";
import {
  SignedCookieManager,
  ResponseSigner,
  PaymentAuthCache,
  ResponseCacheStore,
  createSchemeValidator,
  validateSettlementPayload,
  SlidingWindowLimiter,
  EdgeRateThrottler,
  LatencyHistogram,
  ReceiptStore,
  SettlementReconciler,
  RpcCircuitBreakerManager,
  ReadinessProbe,
  IdempotencyCache,
} from "../src/index.js";

test("malformed cookie signatures return null instead of throwing", () => {
  const cookies = new SignedCookieManager("a".repeat(32));
  expect(cookies.verify("value.short")).toBeNull();
  expect(cookies.verify("value." + "x".repeat(100))).toBeNull();
  expect(cookies.verify(cookies.sign("value.with.dots"))).toBe(
    "value.with.dots",
  );
  expect(() => new SignedCookieManager("")).toThrow();
});

test("receipt uses independently reproducible SHA256 and HMAC, rejects future/tampered receipts", () => {
  const signer = new ResponseSigner({
    signingSecret: "secret-value-abcdefghijklmnopqrstuvwxyz",
    keyId: "key",
  });
  const { receipt } = signer.signReceipt("tx", "request", 200, "Aa");
  expect(receipt.bodyHash).toBe(
    "0x" + createHash("sha256").update("Aa").digest("hex"),
  );
  expect(signer.hashContent("Aa")).not.toBe(signer.hashContent("BB")); // collision in former integer hash
  const message = JSON.stringify([
    "kite-receipt-v1",
    "key",
    "tx",
    "request",
    200,
    receipt.bodyHash,
    receipt.timestampMs,
  ]);
  expect(receipt.signature).toBe(
    "hmac_" +
      createHmac("sha256", "secret-value-abcdefghijklmnopqrstuvwxyz")
        .update(message)
        .digest("hex"),
  );
  expect(signer.verifyReceipt(receipt, "Aa")).toBe(true);
  expect(signer.verifyReceipt({ ...receipt, signature: "bad" }, "Aa")).toBe(
    false,
  );
  expect(
    signer.verifyReceipt({ ...receipt, timestampMs: Date.now() + 60000 }, "Aa"),
  ).toBe(false);
  expect(() => signer.signReceipt('tx"\r\n', "req", 200, "")).toThrow();
});

test("payment policy ignores spoofed headers and enforces trusted amount and verification", async () => {
  const app = new Hono();
  app.use(
    "*",
    createSchemeValidator({
      acceptedSchemes: ["exact"],
      minAmountUsd: 2,
      facilitatorRequired: true,
    }),
  );
  app.get("/", (c) => c.text("paid"));
  expect(
    (await app.request("/", { headers: { "x-payment-scheme": "exact" } }))
      .status,
  ).toBe(402);
  for (const [amountUsd, facilitatorVerified, status] of [
    [1, true, 402],
    [3, false, 402],
    [3, true, 200],
  ] as const) {
    const route = new Hono();
    route.use(
      "*",
      createSchemeValidator(
        {
          acceptedSchemes: ["exact"],
          minAmountUsd: 2,
          facilitatorRequired: true,
        },
        () => ({ scheme: "exact", amountUsd, facilitatorVerified }),
      ),
    );
    route.get("/", (c) => c.text("ok"));
    expect((await route.request("/")).status).toBe(status);
  }
});

test("payload and metrics reject non-finite input", () => {
  const payer = "0x" + "1".repeat(40);
  expect(validateSettlementPayload({ payer, amount: Infinity }).valid).toBe(
    false,
  );
  expect(validateSettlementPayload({ payer, amount: NaN }).valid).toBe(false);
  expect(validateSettlementPayload({ payer, amount: 1 }).valid).toBe(true);
  expect(() => new LatencyHistogram().record(NaN)).toThrow();
  expect(() => new SlidingWindowLimiter(0)).toThrow();
});

test("auth cache actually evicts least recently used key and does not expose internal state", () => {
  const cache = new PaymentAuthCache(60000, 2);
  cache.set("a", "alice");
  cache.set("b", "bob");
  cache.get("a")!.payerAddress = "mallory";
  cache.set("c", "charlie");
  expect(cache.get("b")).toBeNull();
  expect(cache.get("a")!.payerAddress).toBe("alice");
});

test("response cache does not expose public caching, payment receipts or cookies", () => {
  const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });
  const value = cache.set("a", "secret", 200, {
    "Set-Cookie": "secret",
    "Payment-Response": "receipt",
  });
  expect(value.headers["Cache-Control"]).toBe("private, no-store");
  expect(value.headers["Set-Cookie"]).toBeUndefined();
  expect(value.headers["Payment-Response"]).toBeUndefined();
  value.body = "tampered";
  expect(cache.get("a")!.body).toBe("secret");
  expect(cache.generateKey("GET", "/a:b", "c")).not.toBe(
    cache.generateKey("GET", "/a", "b:c"),
  );
});

test("active idempotency reservation survives capacity pressure and clock advancement", () => {
  const cache = new IdempotencyCache({ maxKeys: 1 });
  expect(cache.acquire("a", 1, 0).status).toBe("acquired");
  expect(cache.acquire("a", 1, 100000000).status).toBe("in_flight");
  expect(cache.acquire("b", 1, 100000000).status).toBe("conflict");
  cache.release("a");
  expect(cache.acquire("b").status).toBe("acquired");
});

test("receipt overwrite changes payer index and expiration removes the receipt", () => {
  const store = new ReceiptStore({ retentionMs: 1000 });
  const receipt = {
    txHash: "0xAB",
    requestId: "r",
    payerAddress: "Alice",
    recipientAddress: "merchant",
    amountAtomic: 1n,
    network: "kite",
    timestampMs: Date.now(),
  };
  store.saveReceipt(receipt);
  store.saveReceipt({ ...receipt, payerAddress: "Bob" });
  expect(store.getByPayer("alice")).toHaveLength(0);
  expect(store.getByTxHash("0xab")!.payerAddress).toBe("bob");
  store.saveReceipt({ ...receipt, timestampMs: Date.now() - 1001 });
  expect(store.getByTxHash("0xAB")).toBeUndefined();
});

test("duplicate settlement cannot double payer volume", () => {
  const store = new SettlementReconciler(1);
  const receipt = {
    txHash: "tx",
    payer: "a",
    payTo: "merchant",
    amount: 1n,
    network: "kite",
    timestamp: 1,
    success: true,
  };
  store.record(receipt);
  store.record(receipt);
  expect(store.getByPayer("a")).toHaveLength(1);
  store.record({ ...receipt, txHash: "second", payer: "b" });
  expect(store.getSummary().uniquePayersCount).toBe(1);
});

test("RPC breaker fails closed when every endpoint is unhealthy", () => {
  const manager = new RpcCircuitBreakerManager(["https://rpc.example"], {
    failureThreshold: 1,
  });
  manager.recordFailure("https://rpc.example");
  expect(() => manager.getActiveEndpoint()).toThrow(
    "All RPC circuits are open",
  );
});

test("edge backend malformed count is rejected", async () => {
  const limiter = new EdgeRateThrottler({
    get: async () => null,
    increment: async () => NaN,
  });
  expect(limiter.isAllowed("client")).rejects.toThrow();
});

test("concurrent probe checks coalesce and fallback on HTTP 405", async () => {
  let head = 0,
    get = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      await Bun.sleep(5);
      if (request.method === "HEAD") {
        head++;
        return new Response(null, { status: 405 });
      }
      get++;
      return new Response("ok");
    },
  });
  try {
    const probe = new ReadinessProbe().addTarget({
      name: "local",
      url: server.url.href,
    });
    const values = await Promise.all(
      Array.from({ length: 10 }, () => probe.check()),
    );
    expect(values.every((v) => v.status === "UP")).toBe(true);
    expect(head).toBe(1);
    expect(get).toBe(1);
  } finally {
    await server.stop(true);
  }
});

test("ordinary paid OPTIONS remains verified and settled after SDK upgrade", async () => {
  const { harness, signature } = await import("./helpers.js");
  const { app, events } = harness();
  const sig = await signature(app);
  const response = await app.request("/v1/echo", {
    method: "OPTIONS",
    headers: { "payment-signature": sig },
  });
  expect(response.status).toBe(200);
  expect(events).toEqual(["verify", "upstream", "settle"]);
});
