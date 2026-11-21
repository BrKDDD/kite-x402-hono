import { expect, test } from "bun:test";
import { ReadinessProbe } from "../src/index.js";

function controlledProbe() {
  let started!: () => void;
  let release!: () => void;
  const firstStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const firstResponse = new Promise<void>((resolve) => {
    release = resolve;
  });
  let existingRequests = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname === "/existing") {
        // 只阻塞旧批次，让更新后的批次能在旧结果之前完成。
        if (++existingRequests === 1) {
          started();
          await firstResponse;
        }
        return new Response("ok");
      }
      return new Response("unavailable", { status: 503 });
    },
  });
  const probe = new ReadinessProbe({ cacheTtlMs: 60000, timeoutMs: 2000 });
  probe.addTarget({
    name: "existing",
    url: new URL("/existing", server.url).href,
  });
  const addUnhealthyTarget = () =>
    probe.addTarget({
      name: "new-unhealthy",
      url: new URL("/unhealthy", server.url).href,
    });
  return {
    probe,
    server,
    firstStarted,
    release,
    addUnhealthyTarget,
    requestCount: () => existingRequests,
  };
}

test("adding a target during a probe prevents caching the old target set", async () => {
  const { probe, server, firstStarted, release, addUnhealthyTarget } =
    controlledProbe();
  try {
    const oldCheck = probe.check();
    await firstStarted;
    addUnhealthyTarget();
    release();
    expect((await oldCheck).status).toBe("UP");

    const current = await probe.check();
    expect(current.cached).toBe(false);
    expect(current.status).toBe("DEGRADED");
    expect(current.targets["new-unhealthy"]?.healthy).toBe(false);
  } finally {
    release();
    await server.stop(true);
  }
});

test("checks after adding a target coalesce only with the updated target set", async () => {
  const {
    probe,
    server,
    firstStarted,
    release,
    addUnhealthyTarget,
    requestCount,
  } = controlledProbe();
  try {
    const oldCheck = probe.check();
    await firstStarted;
    addUnhealthyTarget();
    const currentCheck = probe.check();
    const joinedCheck = probe.check();
    release();

    const [old, current, joined] = await Promise.all([
      oldCheck,
      currentCheck,
      joinedCheck,
    ]);
    expect(Object.keys(old.targets)).toEqual(["existing"]);
    expect(current.status).toBe("DEGRADED");
    expect(current.targets["new-unhealthy"]?.statusCode).toBe(503);
    expect(joined).toEqual(current);
    expect(requestCount()).toBe(2);
  } finally {
    release();
    await server.stop(true);
  }
});

test("a late obsolete probe cannot overwrite the new cached snapshot", async () => {
  const { probe, server, firstStarted, release, addUnhealthyTarget } =
    controlledProbe();
  try {
    const oldCheck = probe.check();
    await firstStarted;
    addUnhealthyTarget();

    // 新批次先完成，再放行旧批次，覆盖最容易恢复过时 UP 缓存的顺序。
    const current = await probe.check();
    expect(current.status).toBe("DEGRADED");
    release();
    expect((await oldCheck).status).toBe("UP");

    const cached = await probe.check();
    expect(cached.cached).toBe(true);
    expect(cached.targets).toEqual(current.targets);
    expect(cached.status).toBe("DEGRADED");
  } finally {
    release();
    await server.stop(true);
  }
});
