import { expect, test } from "bun:test";
import { RpcCircuitBreakerManager } from "../src/rpc-circuit-breaker.js";
const a = "https://rpc-a.example",
  b = "https://rpc-b.example";

test("a duplicate cannot remain healthy after the same URL circuit opens", () => {
  const manager = new RpcCircuitBreakerManager([a, a, b], {
    failureThreshold: 1,
  });
  manager.recordFailure(a, 1000);
  expect(manager.getActiveEndpoint(1000)).toBe(b);
  expect(manager.getStatus()).toEqual([
    { url: a, isHealthy: false, failures: 1 },
    { url: b, isHealthy: true, failures: 0 },
  ]);
});
test("duplicate-only configuration reports all circuits open", () => {
  const manager = new RpcCircuitBreakerManager([a, a], { failureThreshold: 1 });
  manager.recordFailure(a, 1000);
  expect(() => manager.getActiveEndpoint(1000)).toThrow(
    "All RPC circuits are open",
  );
});
test("one URL shares consecutive failures and successful recovery", () => {
  const manager = new RpcCircuitBreakerManager([a, b, a], {
    failureThreshold: 2,
  });
  manager.recordFailure(a, 1000);
  expect(manager.getActiveEndpoint(1000)).toBe(a);
  manager.recordFailure(a, 1000);
  expect(manager.getActiveEndpoint(1000)).toBe(b);
  manager.recordSuccess(a);
  expect(manager.getActiveEndpoint(1000)).toBe(a);
  expect(manager.getStatus()[0]).toEqual({
    url: a,
    isHealthy: true,
    failures: 0,
  });
  expect(manager.getStatus()).toHaveLength(2);
});
test("coalescing preserves the existing strict cooldown boundary", () => {
  const manager = new RpcCircuitBreakerManager([a, a, b], {
    failureThreshold: 1,
    cooldownPeriodMs: 50,
  });
  manager.recordFailure(a, 1000);
  expect(manager.getActiveEndpoint(1050)).toBe(b);
  expect(manager.getActiveEndpoint(1051)).toBe(a);
});
test("first occurrence order, exact URL identity and caller input remain unchanged", () => {
  const urls = [b, a, b, a + "/"];
  const manager = new RpcCircuitBreakerManager(urls);
  expect(urls).toEqual([b, a, b, a + "/"]);
  urls.push("https://later.example");
  expect(manager.getActiveEndpoint()).toBe(b);
  // 不合并不同拼写；recordFailure/recordSuccess 继续以原始 URL 字符串为键。
  expect(manager.getStatus().map((x) => x.url)).toEqual([b, a, a + "/"]);
  expect(() => new RpcCircuitBreakerManager([])).toThrow();
});
