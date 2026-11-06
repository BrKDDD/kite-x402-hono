import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { Hono } from "hono";
import {
  CachedReadinessProbe,
  isValidCorsOrigin,
  matchSubdomainOrigin,
  TokenBlacklist,
  SettlementBus,
  adaptiveRateLimiter,
  verifyHmacSignature,
} from "../src/index.js";

test("readiness snapshots cannot mutate retained health and expire exactly at TTL", () => {
  const original = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    const probe = new CachedReadinessProbe(10);
    const details = { database: true };
    probe.recordStatus(true, details).details.database = false;
    details.database = false;
    expect(probe.getCachedOrStale()?.details.database).toBe(true);
    now += 10;
    expect(probe.getCachedOrStale()).toBeNull();
    expect(() => new CachedReadinessProbe(NaN)).toThrow();
  } finally {
    Date.now = original;
  }
});

test("CORS accepts only complete serialized origins and deterministic full host matches", () => {
  expect(isValidCorsOrigin("null", ["*"])).toBe(false);
  expect(isValidCorsOrigin("https://kite.ai/path", ["*"])).toBe(false);
  expect(isValidCorsOrigin("https://kite.ai", ["*"], true)).toBe(false);
  expect(isValidCorsOrigin("https://kite.ai", ["https://kite.ai"], true)).toBe(
    true,
  );
  const pattern = /(?:[a-z]+\.)?kite\.ai/g;
  pattern.lastIndex = 2;
  for (let i = 0; i < 3; i++)
    expect(matchSubdomainOrigin("https://app.kite.ai", pattern)).toBe(true);
  expect(pattern.lastIndex).toBe(2);
  for (const origin of [
    "https://evil-kite.ai",
    "http://app.kite.ai",
    "https://app.kite.ai/secret",
    "https://app.kite.ai.attacker.com",
  ])
    expect(matchSubdomainOrigin(origin, pattern)).toBe(false);
});

test("blacklist preserves active revocations at capacity and converts JWT seconds", () => {
  const original = Date.now;
  let now = 100000;
  Date.now = () => now;
  try {
    const list = new TokenBlacklist(1);
    list.revokeJwt("a", 110);
    list.revoke("a", 105000);
    expect(() => list.revoke("b", 120000)).toThrow("capacity");
    expect(list.isRevoked("a")).toBe(true);
    now = 110000;
    expect(list.isRevoked("a")).toBe(false);
    list.revoke("b", 120000);
    expect(list.isRevoked("b")).toBe(true);
    expect(() => list.revoke("", NaN)).toThrow();
  } finally {
    Date.now = original;
  }
});

test("settlement bus preserves atomic precision and freezes listener snapshots", () => {
  const bus = new SettlementBus();
  let amount: unknown;
  bus.on("settlement", (event) => {
    amount = event.amount;
    expect(Object.isFrozen(event)).toBe(true);
  });
  expect(
    bus.emitSettlement({
      payer: "alice",
      txHash: "tx",
      amount: "9007199254740993",
    }),
  ).toBe(true);
  expect(amount).toBe("9007199254740993");
  expect(() =>
    bus.emitSettlement({
      payer: "alice",
      txHash: "tx",
      amount: Number.MAX_SAFE_INTEGER + 1,
    }),
  ).toThrow();
});

test("limiter uses trusted identity rather than spoofed forwarding headers", async () => {
  const app = new Hono();
  app.use(
    adaptiveRateLimiter({ maxRequests: 1, keyGenerator: () => "socket-peer" }),
  );
  app.get("/", (c) => c.text("ok"));
  expect(
    (await app.request("/", { headers: { "x-forwarded-for": "1.1.1.1" } }))
      .status,
  ).toBe(200);
  const denied = await app.request("/", {
    headers: { "x-forwarded-for": "2.2.2.2" },
  });
  expect(denied.status).toBe(429);
  expect(Number(denied.headers.get("Retry-After"))).toBeGreaterThan(0);
  expect(() =>
    adaptiveRateLimiter({ maxRequests: 0, keyGenerator: () => "x" }),
  ).toThrow();
});

test("HMAC rejects malformed hex and binds freshness timestamp into signed bytes", async () => {
  const secret = "x".repeat(32);
  const payload = "{}";
  const sign = (message: string) =>
    createHmac("sha256", secret).update(message).digest("hex");
  const timestamp = String(Date.now());
  expect(
    (await verifyHmacSignature(payload, secret, sign(payload))).isValid,
  ).toBe(true);
  expect(
    (await verifyHmacSignature(payload, secret, sign(payload), timestamp))
      .isValid,
  ).toBe(false);
  const signature = sign(`${timestamp}.${payload}`);
  expect(
    (await verifyHmacSignature(payload, secret, signature, timestamp)).isValid,
  ).toBe(true);
  expect(
    (
      await verifyHmacSignature(
        payload,
        secret,
        signature,
        String(Number(timestamp) + 1),
      )
    ).isValid,
  ).toBe(false);
  expect(
    (await verifyHmacSignature(payload, secret, signature + "z")).isValid,
  ).toBe(false);
  expect(
    (await verifyHmacSignature(payload, secret, signature, timestamp + "junk"))
      .isValid,
  ).toBe(false);
});
