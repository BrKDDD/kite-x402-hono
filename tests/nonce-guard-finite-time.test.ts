import { expect, test } from "bun:test";
import { PaymentNonceReplayGuard } from "../src/nonce-guard.js";
const invalidTimes = [NaN, Infinity, -Infinity];

for (const operation of [
  "acquire",
  "reserve",
  "commit",
  "check",
  "size",
] as const) {
  test(`${operation} rejects a non-finite clock without replacing an active owner`, () => {
    for (const now of invalidTimes) {
      const guard = new PaymentNonceReplayGuard({ consumedTtlMs: 10 });
      const owner = guard.reserve("payer", "nonce", 0)!;
      const invoke = () =>
        operation === "size"
          ? guard.size(now)
          : guard[operation]("payer", "nonce", now);
      expect(invoke).toThrow("finite");
      expect(guard.check("payer", "nonce", 0)).toBe("IN_FLIGHT");
      // 仍是同一所有者；非法时钟不能撤销或替换其提交权。
      owner.commit(5);
      expect(guard.check("payer", "nonce", 6)).toBe("CONSUMED");
    }
  });
}

test("owner commit rejects a non-finite time before updating expiry", () => {
  for (const now of invalidTimes) {
    const guard = new PaymentNonceReplayGuard({ consumedTtlMs: 10 });
    const owner = guard.reserve("payer", "nonce", 0)!;
    expect(() => owner.commit(now)).toThrow("finite");
    expect(guard.check("payer", "nonce", 0)).toBe("IN_FLIGHT");
    owner.release();
    expect(guard.check("payer", "nonce", 0)).toBe("AVAILABLE");
  }
});

test("finite times retain owner isolation and the exact consumed deadline", () => {
  const guard = new PaymentNonceReplayGuard({ consumedTtlMs: 10 });
  const first = guard.reserve("payer", "nonce", 0)!;
  expect(guard.check("payer", "nonce", -1)).toBe("IN_FLIGHT");
  first.release();
  const second = guard.reserve("payer", "nonce", 1)!;
  first.commit(2);
  second.commit(5);
  expect(guard.check("payer", "nonce", 14)).toBe("CONSUMED");
  expect(guard.check("payer", "nonce", 15)).toBe("AVAILABLE");
  expect(guard.acquire("payer", "nonce", 15)).toBe(true);
});
