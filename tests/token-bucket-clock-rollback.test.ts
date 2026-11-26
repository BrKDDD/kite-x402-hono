import { expect, test } from "bun:test";
import {
  TokenBucketRateLimiter,
  AdaptiveRateLimiter,
} from "../src/rate-limiter.js";
test("returning to the last debit time must not invent a refill", () => {
  const limiter = new TokenBucketRateLimiter({ rps: 1, burst: 1 });
  expect(limiter.consume("agent", 10000).allowed).toBe(true);
  expect(limiter.consume("agent", 9000).allowed).toBe(false);
  expect(limiter.consume("agent", 10000).allowed).toBe(false);
  expect(limiter.consume("agent", 11000).allowed).toBe(true);
});
test("repeated clock rollback cannot earn tokens through cleanup", () => {
  const limiter = new TokenBucketRateLimiter({ rps: 1, burst: 1 });
  limiter.consume("agent", 10000);
  for (const at of [1000, 10000, 5000, 10000])
    expect(limiter.consume("agent", at).allowed).toBe(false);
  expect(limiter.size()).toBe(1);
});
test("partial refill progress survives rollback without double credit", () => {
  const limiter = new TokenBucketRateLimiter({ rps: 0.5, burst: 1 });
  limiter.consume("agent", 10000);
  expect(limiter.consume("agent", 11000).allowed).toBe(false);
  expect(limiter.consume("agent", 10000).allowed).toBe(false);
  expect(limiter.consume("agent", 11000).allowed).toBe(false);
  expect(limiter.consume("agent", 12000).allowed).toBe(true);
});
test("independent keys, reset and ordinary forward refill stay compatible", () => {
  const limiter = new TokenBucketRateLimiter({ rps: 2, burst: 2 });
  expect(limiter.consume("a", 10000).remaining).toBe(1);
  expect(limiter.consume("a", 10000).remaining).toBe(0);
  expect(limiter.consume("b", 10000).allowed).toBe(true);
  expect(limiter.consume("a", 10500).allowed).toBe(true);
  limiter.reset("a");
  expect(limiter.consume("a", 10500).remaining).toBe(1);
});
test("the existing adaptive limiter remains a rollback-safe control", () => {
  const limiter = new AdaptiveRateLimiter({ capacity: 1, refillRatePerSec: 1 });
  expect(limiter.consume("a", 1, 10000).allowed).toBe(true);
  expect(limiter.consume("a", 1, 9000).allowed).toBe(false);
  expect(limiter.consume("a", 1, 10000).allowed).toBe(false);
  expect(limiter.consume("a", 1, 11000).allowed).toBe(true);
});
