import { expect, test } from "bun:test";
import { TrafficShaper } from "../src/traffic-shaper.js";

test("unsupported long queue deadlines fail before the runtime truncates them", () => {
  for (const queueTimeoutMs of [2147483648, Number.MAX_SAFE_INTEGER, 1e12])
    expect(
      () =>
        new TrafficShaper({
          maxConcurrency: 1,
          maxQueueDepth: 1,
          queueTimeoutMs,
        }),
    ).toThrow();
});

for (const queueTimeoutMs of [0, 2147483647]) {
  test(`supported deadline ${queueTimeoutMs} does not reject a queued task early`, async () => {
    const shaper = new TrafficShaper({
      maxConcurrency: 1,
      maxQueueDepth: 1,
      queueTimeoutMs,
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const active = shaper.schedule(() => gate);
    let state = "pending";
    const queued = shaper.schedule(async () => "queued");
    const observed = queued.then(
      () => {
        state = "resolved";
      },
      () => {
        state = "rejected";
      },
    );
    try {
      await Bun.sleep(20);
      expect(state).toBe("pending");
      expect(shaper.stats.queued).toBe(1);
    } finally {
      // 无论断言结果如何都释放活动任务，让最大时长的 timer 也被清理。
      release();
      await active;
      await observed;
    }
    expect(await queued).toBe("queued");
    expect(shaper.stats).toMatchObject({ active: 0, queued: 0 });
  });
}

test("short queue expiry still frees capacity for a replacement task", async () => {
  const shaper = new TrafficShaper({
    maxConcurrency: 1,
    maxQueueDepth: 1,
    queueTimeoutMs: 10,
  });
  let release!: () => void;
  const active = shaper.schedule(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let expiredRuns = 0;
  const expired = shaper.schedule(async () => {
    expiredRuns++;
  });
  try {
    await expect(expired).rejects.toThrow("queued timeout");
    expect(shaper.stats.queued).toBe(0);
    const replacement = shaper.schedule(async () => "recovered");
    release();
    await active;
    expect(await replacement).toBe("recovered");
    expect(expiredRuns).toBe(0);
    expect(shaper.stats).toMatchObject({ active: 0, queued: 0 });
  } finally {
    release();
    await active;
    await expired.catch(() => {});
  }
});

test("supported fractional queue milliseconds remain accepted", () => {
  expect(
    () =>
      new TrafficShaper({
        maxConcurrency: 1,
        maxQueueDepth: 1,
        queueTimeoutMs: 0.5,
      }),
  ).not.toThrow();
});
