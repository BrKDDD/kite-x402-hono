import { expect, test } from "bun:test";
import { SlidingWindowLimiter } from "../src/middleware/sliding-window-limiter.js";
function clock(run: (set: (value: number) => void) => void) {
  const old = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    run((v) => {
      now = v;
    });
  } finally {
    Date.now = old;
  }
}
test("repeated existing-client traffic still consumes the exact budget", () =>
  clock(() => {
    const limiter = new SlidingWindowLimiter(100, 3);
    expect(limiter.check("a").remaining).toBe(2);
    expect(limiter.check("a").remaining).toBe(1);
    expect(limiter.check("a").remaining).toBe(0);
    expect(limiter.check("a").allowed).toBe(false);
    expect(limiter.check("b").remaining).toBe(2);
  }));
test("per-key expiry works before the next whole-map sweep", () =>
  clock((set) => {
    const limiter = new SlidingWindowLimiter(100, 1);
    expect(limiter.check("a").allowed).toBe(true);
    set(1099);
    expect(limiter.check("a").allowed).toBe(false);
    set(1100);
    expect(limiter.check("a").allowed).toBe(true);
  }));
test("new clients reclaim expired capacity at the exact window boundary", () =>
  clock((set) => {
    const limiter = new SlidingWindowLimiter(100, 1);
    for (let i = 0; i < 10000; i++)
      expect(limiter.check(String(i)).allowed).toBe(true);
    expect(limiter.check("overflow").allowed).toBe(false);
    set(1100);
    expect(limiter.check("overflow").allowed).toBe(true);
    expect(limiter.check("0").allowed).toBe(true);
  }));
test("capacity pressure never evicts a still-active quota window", () =>
  clock((set) => {
    const limiter = new SlidingWindowLimiter(1000, 1);
    for (let i = 0; i < 10000; i++) limiter.check(String(i));
    set(1100);
    expect(limiter.check("overflow").allowed).toBe(false);
    expect(limiter.check("0").allowed).toBe(false);
    set(2000);
    expect(limiter.check("overflow").allowed).toBe(true);
  }));
test("partially expired windows retain the remaining live debits", () =>
  clock((set) => {
    const limiter = new SlidingWindowLimiter(100, 2);
    expect(limiter.check("a").allowed).toBe(true);
    set(1050);
    expect(limiter.check("a").allowed).toBe(true);
    set(1100);
    expect(limiter.check("a").remaining).toBe(0);
    expect(limiter.check("a").allowed).toBe(false);
    set(1150);
    expect(limiter.check("a").allowed).toBe(true);
  }));
