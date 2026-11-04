import { describe, it, expect } from "bun:test";
import { RpcCircuitBreakerManager } from "../src/rpc-circuit-breaker.js";

describe("RpcCircuitBreakerManager", () => {
  const urls: [string, string] = [
    "https://rpc-1.kite.ai",
    "https://rpc-2.kite.ai",
  ];

  it("selects first active RPC endpoint", () => {
    const manager = new RpcCircuitBreakerManager(urls);
    expect(manager.getActiveEndpoint()).toBe(urls[0]);
  });

  it("fails over to backup RPC upon consecutive failures", () => {
    const manager = new RpcCircuitBreakerManager(urls, { failureThreshold: 2 });
    manager.recordFailure(urls[0]);
    manager.recordFailure(urls[0]);

    expect(manager.getActiveEndpoint()).toBe(urls[1]);
  });

  it("recovers endpoint after cooldown period", () => {
    const manager = new RpcCircuitBreakerManager(urls, {
      failureThreshold: 1,
      cooldownPeriodMs: 50,
    });
    const now = 1000;
    manager.recordFailure(urls[0], now);
    expect(manager.getActiveEndpoint(now)).toBe(urls[1]);

    // After cooldown
    expect(manager.getActiveEndpoint(now + 60)).toBe(urls[0]);
  });
});
