import { describe, it, expect } from "bun:test";
import { TrafficShaper } from "../src/traffic-shaper.js";

describe("TrafficShaper", () => {
  it("executes immediately when concurrency capacity is available", async () => {
    const shaper = new TrafficShaper({ maxConcurrency: 2, maxQueueDepth: 5 });
    const result = await shaper.schedule(async () => "success");
    expect(result).toBe("success");
    expect(shaper.stats.active).toBe(0);
  });

  it("prioritizes higher priority requests in the queue", async () => {
    const shaper = new TrafficShaper({ maxConcurrency: 1, maxQueueDepth: 5 });
    const order: number[] = [];

    // Occupy slot
    const task1 = shaper.schedule(
      () => new Promise((resolve) => setTimeout(resolve, 50)),
    );

    // Queue low priority
    shaper.schedule(async () => {
      order.push(1);
    }, 1);

    // Queue high priority
    shaper.schedule(async () => {
      order.push(99);
    }, 99);

    await task1;
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(order[0]).toBe(99);
    expect(order[1]).toBe(1);
  });

  it("rejects when queue capacity is exceeded", async () => {
    const shaper = new TrafficShaper({ maxConcurrency: 1, maxQueueDepth: 1 });
    shaper.schedule(() => new Promise(() => {})); // occupies slot
    shaper.schedule(() => new Promise(() => {})); // occupies queue 1

    expect(shaper.schedule(() => Promise.resolve())).rejects.toThrow(
      "overflow",
    );
  });
});
