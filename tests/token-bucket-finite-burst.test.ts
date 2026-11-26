import { expect, test } from "bun:test";
import { TokenBucketRateLimiter } from "../src/rate-limiter.js";

test("explicit non-finite and unsafe bursts cannot create an unlimited bucket", () => {
  for (const burst of [NaN, Infinity, -Infinity, 2 ** 53, Number.MAX_VALUE])
    expect(() => new TokenBucketRateLimiter({ rps: 1, burst })).toThrow();
});

test("implicit burst overflow and unsafe defaults are rejected", () => {
  for (const rps of [Number.MAX_VALUE, Number.MAX_SAFE_INTEGER])
    expect(() => new TokenBucketRateLimiter({ rps })).toThrow();
});

test("the safe upper boundary still consumes individual tokens exactly", () => {
  const limiter = new TokenBucketRateLimiter({
    rps: 1,
    burst: Number.MAX_SAFE_INTEGER,
  });
  // 每次扣一枚令牌必须真实减少容量，不能因浮点精度让配额保持不变。
  expect(limiter.consume("fixture", 0).remaining).toBe(
    Number.MAX_SAFE_INTEGER - 1,
  );
  expect(limiter.consume("fixture", 0).remaining).toBe(
    Number.MAX_SAFE_INTEGER - 2,
  );
});

test("finite fallback behavior and ordinary burst admission stay compatible", () => {
  for (const burst of [undefined, 0, -1, 1]) {
    const limiter = new TokenBucketRateLimiter({
      rps: 2,
      ...(burst === undefined ? {} : { burst }),
    });
    expect(limiter.getBurst()).toBe(4);
    for (let i = 0; i < 4; i++)
      expect(limiter.consume("fixture", 0).allowed).toBe(true);
    expect(limiter.consume("fixture", 0).allowed).toBe(false);
  }
  const explicit = new TokenBucketRateLimiter({ rps: 2, burst: 3 });
  expect(explicit.getBurst()).toBe(3);
  const fractional = new TokenBucketRateLimiter({ rps: 0.1, burst: 1 });
  expect(fractional.consume("fixture", 0).allowed).toBe(true);
  expect(fractional.consume("fixture", 0).allowed).toBe(false);
  expect(fractional.consume("fixture", 10000).allowed).toBe(true);
});
