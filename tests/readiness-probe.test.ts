import { describe, expect, test } from "bun:test";
import { ReadinessProbe } from "../src/readiness-probe.js";

describe("readiness-probe", () => {
  test("returns UP when no targets configured", async () => {
    const probe = new ReadinessProbe();
    const snapshot = await probe.check();
    expect(snapshot.status).toBe("UP");
    expect(snapshot.cached).toBe(false);
  });

  test("probes targets and caches subsequent calls within TTL", async () => {
    const probe = new ReadinessProbe({ cacheTtlMs: 500 });
    probe.addTarget({ name: "mock-target", url: "https://example.com" });

    const snap1 = await probe.check();
    expect(snap1.cached).toBe(false);
    expect(snap1.targets["mock-target"]).toBeDefined();

    const snap2 = await probe.check();
    expect(snap2.cached).toBe(true);
    expect(snap2.timestamp).toBe(snap1.timestamp);

    // Force probe bypasses cache
    const snap3 = await probe.check(true);
    expect(snap3.cached).toBe(false);
  });

  test("handles unreachable target gracefully and reports DOWN/DEGRADED", async () => {
    const probe = new ReadinessProbe({ timeoutMs: 50 });
    probe.addTarget({
      name: "dead-target",
      url: "http://127.0.0.1:54321/nonexistent",
    });

    const snap = await probe.check();
    expect(snap.status).toBe("DOWN");
    expect(snap.targets["dead-target"]?.healthy).toBe(false);
  });
});
