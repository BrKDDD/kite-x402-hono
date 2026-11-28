import { expect, test } from "bun:test";
import { TrafficShaper } from "../src/traffic-shaper.js";

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test("a long run of synchronous callback failures drains without stack overflow", async () => {
  // 在子进程复现旧实现的栈溢出，避免原始故障破坏其他测试。
  const moduleUrl = new URL("../src/traffic-shaper.ts", import.meta.url).href;
  const source = `
    const { TrafficShaper } = await import(${JSON.stringify(moduleUrl)});
    const shaper = new TrafficShaper({ maxConcurrency: 1, maxQueueDepth: 20000, queueTimeoutMs: 0 });
    let release;
    const head = shaper.schedule(() => new Promise(resolve => { release = resolve; }));
    const tasks = Array.from({ length: 20000 }, () => shaper.schedule(() => { throw new Error("expected failure"); }));
    const settled = Promise.allSettled(tasks);
    release();
    await head;
    const outcomes = await settled;
    console.log(JSON.stringify({ rejected: outcomes.filter(r => r.status === "rejected").length, stats: shaper.stats }));
  `;
  const child = Bun.spawn([process.execPath, "--no-env-file", "-e", source], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 8000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout as ReadableStream).text(),
      new Response(child.stderr as ReadableStream).text(),
      child.exited,
    ]);
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
    expect(JSON.parse(stdout)).toMatchObject({
      rejected: 20000,
      stats: { active: 0, queued: 0 },
    });
  } finally {
    clearTimeout(timer);
    child.kill();
  }
}, 12000);

test("sync and async failures preserve priority and allow later successes", async () => {
  const shaper = new TrafficShaper({
    maxConcurrency: 1,
    maxQueueDepth: 3,
    queueTimeoutMs: 0,
  });
  const blocked = gate();
  const head = shaper.schedule(() => blocked.promise);
  const order: number[] = [];
  const low = shaper.schedule(async () => {
    order.push(1);
    return "ok";
  }, 1);
  const sync = shaper.schedule(() => {
    order.push(3);
    throw new Error("sync");
  }, 3);
  const asyncFailure = shaper.schedule(async () => {
    order.push(2);
    throw new Error("async");
  }, 2);
  const settled = Promise.allSettled([low, sync, asyncFailure]);
  blocked.release();
  await head;
  expect(await settled).toMatchObject([
    { status: "fulfilled", value: "ok" },
    { status: "rejected" },
    { status: "rejected" },
  ]);
  expect(order).toEqual([3, 2, 1]);
  expect(shaper.stats).toMatchObject({ active: 0, queued: 0 });
});

test("independent released slots keep the configured concurrency bound", async () => {
  const shaper = new TrafficShaper({
    maxConcurrency: 2,
    maxQueueDepth: 8,
    queueTimeoutMs: 0,
  });
  const first = gate(),
    second = gate();
  const heads = [
    shaper.schedule(() => first.promise),
    shaper.schedule(() => second.promise),
  ];
  let active = 0,
    peak = 0;
  const jobs = Array.from({ length: 8 }, () =>
    shaper.schedule(async () => {
      active++;
      peak = Math.max(peak, active);
      await Bun.sleep(1);
      active--;
    }),
  );
  first.release();
  second.release();
  await Promise.all([...heads, ...jobs]);
  expect(peak).toBe(2);
  expect(shaper.stats).toMatchObject({ active: 0, queued: 0 });
});
