import { describe, expect, test } from "bun:test";
import {
  computeBackoffDelay,
  executeWithRetry,
  isTransientError,
} from "../src/retry-backoff.js";

describe("retry-backoff", () => {
  test("computes backoff delay correctly without jitter", () => {
    const delay1 = computeBackoffDelay(1, 100, 1000, 2, false);
    const delay2 = computeBackoffDelay(2, 100, 1000, 2, false);
    const delay3 = computeBackoffDelay(3, 100, 1000, 2, false);

    expect(delay1).toBe(100);
    expect(delay2).toBe(200);
    expect(delay3).toBe(400);
  });

  test("computes backoff delay with jitter within upper bound", () => {
    for (let i = 0; i < 20; i++) {
      const delay = computeBackoffDelay(2, 100, 1000, 2, true);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(200);
    }
  });

  test("identifies transient errors properly", () => {
    expect(isTransientError(new Error("fetch failed"))).toBe(true);
    expect(isTransientError(new Error("ECONNRESET"))).toBe(true);
    expect(isTransientError({ status: 503 })).toBe(true);
    expect(isTransientError({ status: 402 })).toBe(false);
    expect(isTransientError(new Error("invalid signature"))).toBe(false);
  });

  test("succeeds immediately on first attempt if no error", async () => {
    let attempts = 0;
    const res = await executeWithRetry(async (att) => {
      attempts = att;
      return "success";
    });

    expect(res).toBe("success");
    expect(attempts).toBe(1);
  });

  test("retries transient failures and eventually succeeds", async () => {
    let calls = 0;
    const res = await executeWithRetry(
      async () => {
        calls++;
        if (calls < 3) {
          throw new Error("network error");
        }
        return "recovered";
      },
      {
        maxAttempts: 4,
        initialDelayMs: 10,
        maxDelayMs: 50,
      },
    );

    expect(res).toBe("recovered");
    expect(calls).toBe(3);
  });

  test("throws if max attempts exceeded", async () => {
    let calls = 0;
    await expect(
      executeWithRetry(
        async () => {
          calls++;
          throw new Error("econnreset");
        },
        {
          maxAttempts: 2,
          initialDelayMs: 5,
        },
      ),
    ).rejects.toThrow("econnreset");

    expect(calls).toBe(2);
  });
});
