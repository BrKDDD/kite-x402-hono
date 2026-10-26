import { describe, expect, test } from "bun:test";
import {
  CircuitBreaker,
  CircuitBreakerOpenError,
} from "../src/circuit-breaker.js";

describe("CircuitBreaker", () => {
  test("initial state is CLOSED and allows executions", async () => {
    const cb = new CircuitBreaker();
    expect(cb.getState()).toBe("CLOSED");

    const result = await cb.execute(async () => 42);
    expect(result).toBe(42);
    expect(cb.getStats().successes).toBe(1);
    expect(cb.getStats().failures).toBe(0);
  });

  test("trips to OPEN after consecutive failures threshold", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 3, recoveryTimeoutMs: 100 });

    for (let i = 0; i < 3; i++) {
      await expect(
        cb.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
    }

    expect(cb.getState()).toBe("OPEN");
    expect(cb.getStats().totalTrips).toBe(1);

    // Rejection while OPEN
    await expect(cb.execute(async () => "ok")).rejects.toBeInstanceOf(
      CircuitBreakerOpenError,
    );
    expect(cb.getStats().rejectedCount).toBe(1);
  });

  test("recovers via HALF_OPEN after timeout", async () => {
    const cb = new CircuitBreaker({
      failureThreshold: 2,
      recoveryTimeoutMs: 50,
      halfOpenSuccessThreshold: 2,
    });

    for (let i = 0; i < 2; i++) {
      await expect(
        cb.execute(async () => {
          throw new Error("fail");
        }),
      ).rejects.toThrow("fail");
    }

    expect(cb.getState()).toBe("OPEN");

    // Wait for recovery timeout
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(cb.getState()).toBe("HALF_OPEN");

    // 1st success in HALF_OPEN
    await cb.execute(async () => "probe 1");
    expect(cb.getState()).toBe("HALF_OPEN");

    // 2nd success in HALF_OPEN recovers to CLOSED
    await cb.execute(async () => "probe 2");
    expect(cb.getState()).toBe("CLOSED");
  });
});
