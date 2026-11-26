import { expect, test } from "bun:test";
import { ReadinessProbe } from "../src/readiness-probe.js";
async function fixture(run: (probe: ReadinessProbe) => Promise<void>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response("unavailable", { status: 503 }),
  });
  try {
    const probe = new ReadinessProbe({ timeoutMs: 1000, cacheTtlMs: 60000 });
    probe.addTarget({ name: "__proto__", url: server.url.href });
    probe.addTarget({ name: "constructor", url: server.url.href });
    probe.addTarget({ name: "ordinary", url: server.url.href });
    await run(probe);
  } finally {
    await server.stop(true);
  }
}
test("reserved names survive snapshot cloning as own target entries", async () =>
  fixture(async (probe) => {
    const snap = await probe.check();
    expect(snap.status).toBe("DOWN");
    expect(Object.keys(snap.targets)).toEqual([
      "__proto__",
      "constructor",
      "ordinary",
    ]);
    expect(Object.hasOwn(snap.targets, "__proto__")).toBe(true);
    expect(snap.targets["__proto__"]?.healthy).toBe(false);
    expect(snap.targets["__proto__"]?.statusCode).toBe(503);
  }));
test("JSON evidence contains reserved target names without inherited health", async () =>
  fixture(async (probe) => {
    const snap = await probe.check();
    const saved = JSON.parse(JSON.stringify(snap));
    expect(Object.hasOwn(saved.targets, "__proto__")).toBe(true);
    expect(saved.targets["__proto__"].name).toBe("__proto__");
    expect(saved.targets["constructor"].healthy).toBe(false);
    expect(({} as Record<string, unknown>).healthy).toBeUndefined();
  }));
test("cached and forced checks retain complete target maps", async () =>
  fixture(async (probe) => {
    const first = await probe.check();
    const cached = await probe.check();
    expect(cached.cached).toBe(true);
    expect(Object.keys(cached.targets)).toHaveLength(3);
    expect(cached.targets["__proto__"]).toEqual(first.targets["__proto__"]);
    const forced = await probe.check(true);
    expect(forced.cached).toBe(false);
    expect(Object.keys(forced.targets)).toHaveLength(3);
  }));
test("returned reserved-name entries cannot mutate the retained snapshot", async () =>
  fixture(async (probe) => {
    const first = await probe.check();
    expect(Object.hasOwn(first.targets, "__proto__")).toBe(true);
    first.targets["__proto__"]!.healthy = true;
    delete first.targets["ordinary"];
    const second = await probe.check();
    expect(second.targets["__proto__"]?.healthy).toBe(false);
    expect(second.targets["ordinary"]?.healthy).toBe(false);
    expect(second.status).toBe("DOWN");
  }));
