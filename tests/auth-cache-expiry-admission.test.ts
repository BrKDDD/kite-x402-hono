import { expect, test } from "bun:test";
import { PaymentAuthCache } from "../src/cache/payment-auth-cache.js";
function clock(run: (set: (value: number) => void) => void) {
  const original = Date.now;
  let now = 1000;
  Date.now = () => now;
  try {
    run((value) => {
      now = value;
    });
  } finally {
    Date.now = original;
  }
}
test("auth records are unavailable exactly at the expiry deadline", () =>
  clock((set) => {
    const cache = new PaymentAuthCache(100, 2);
    cache.set("key", "alice");
    set(1099);
    expect(cache.get("key")?.payerAddress).toBe("alice");
    set(1100);
    expect(cache.get("key")).toBeNull();
  }));
test("an expired LRU tail cannot evict a still-valid authorization", () =>
  clock((set) => {
    const cache = new PaymentAuthCache(100, 2);
    cache.set("old", "alice");
    set(1050);
    cache.set("live", "bob");
    set(1099);
    cache.get("old");
    set(1100);
    cache.set("new", "carol");
    expect(cache.get("live")?.payerAddress).toBe("bob");
    expect(cache.get("old")).toBeNull();
    expect(cache.get("new")?.payerAddress).toBe("carol");
    expect(cache.size()).toBe(2);
  }));
test("capacity pressure reclaims all expired entries before insertion", () =>
  clock((set) => {
    const cache = new PaymentAuthCache(100, 2);
    cache.set("a", "alice");
    cache.set("b", "bob");
    set(1100);
    cache.set("c", "carol");
    expect(cache.size()).toBe(1);
    expect(cache.get("a")).toBeNull();
    expect(cache.get("b")).toBeNull();
  }));
test("fresh entries still use the existing LRU victim and return copies", () =>
  clock(() => {
    const cache = new PaymentAuthCache(100, 2);
    cache.set("a", "alice");
    cache.set("b", "bob");
    const value = cache.get("a")!;
    value.payerAddress = "changed";
    cache.set("c", "carol");
    expect(cache.get("b")).toBeNull();
    expect(cache.get("a")?.payerAddress).toBe("alice");
    expect(cache.size()).toBe(2);
  }));
test("replacement renews timestamps and keeps the configured bound", () =>
  clock((set) => {
    const cache = new PaymentAuthCache(100, 1);
    cache.set("", "alice");
    set(1050);
    cache.set("", "bob", "exact");
    expect(cache.get("")).toEqual({
      payerAddress: "bob",
      scheme: "exact",
      verifiedAt: 1050,
      expiresAt: 1150,
    });
    expect(cache.size()).toBe(1);
    set(1149);
    expect(cache.get("")?.payerAddress).toBe("bob");
  }));
