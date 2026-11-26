import { expect, test } from "bun:test";
import { TokenBucketRateLimiter } from "../src/rate-limiter.js";
test("every positive fractional default rate can admit at least one request", () => {
  for (const rps of [0.01, 0.1, 0.49, 0.5]) {
    const limiter = new TokenBucketRateLimiter({ rps });
    expect(limiter.getBurst()).toBe(1);
    expect(limiter.consume("agent", 0).allowed).toBe(true);
    expect(limiter.consume("agent", 0).allowed).toBe(false);
  }
});
test("low-rate defaults replenish one request only after the correct interval", () => {
  const limiter = new TokenBucketRateLimiter({ rps: 0.1 });
  expect(limiter.consume("agent", 0).allowed).toBe(true);
  expect(limiter.consume("agent", 9000).allowed).toBe(false);
  expect(limiter.consume("agent", 10000).allowed).toBe(true);
});
test("finite below-rps burst fallback also remains usable", () => {
  const limiter = new TokenBucketRateLimiter({ rps: 0.1, burst: 0.05 });
  expect(limiter.getBurst()).toBe(1);
  expect(limiter.consume("agent", 0).allowed).toBe(true);
});
test("explicit usable bursts retain their configured capacity", () => {
  const limiter = new TokenBucketRateLimiter({ rps: 0.1, burst: 2 });
  expect(limiter.getBurst()).toBe(2);
  expect(limiter.consume("a", 0).remaining).toBe(1);
  expect(limiter.consume("a", 0).remaining).toBe(0);
  expect(limiter.consume("a", 0).allowed).toBe(false);
});
test("ordinary defaults keep the existing two-second burst", () => {
  for (const rps of [1, 2, 100]) {
    const limiter = new TokenBucketRateLimiter({ rps });
    expect(limiter.getBurst()).toBe(rps * 2);
    expect(limiter.getLimit()).toBe(rps);
  }
});
