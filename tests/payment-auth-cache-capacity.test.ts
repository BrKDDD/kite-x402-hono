import { expect, test } from "bun:test";
import { PaymentAuthCache } from "../src/index.js";

test("an empty oldest auth key cannot bypass the capacity limit", () => {
  const cache = new PaymentAuthCache(60000, 1);
  cache.set("", "first");

  // 空字符串属于现有 API 接受的键，容量限制也必须覆盖这个边界。
  for (let index = 0; index < 3; index++) {
    const key = String(index);
    cache.set(key, "next");
    expect(cache.size()).toBe(1);
    expect(cache.get(key)?.payerAddress).toBe("next");
  }
  expect(cache.get("")).toBeNull();
  expect(cache.get("0")).toBeNull();
  expect(cache.get("1")).toBeNull();
});

test("auth cache access updates empty-key recency before eviction", () => {
  const cache = new PaymentAuthCache(60000, 2);
  cache.set("", "empty");
  cache.set("other", "other");
  expect(cache.get("")?.payerAddress).toBe("empty");

  cache.set("new", "new");
  expect(cache.size()).toBe(2);
  expect(cache.get("other")).toBeNull();

  // 读取顺序只刷新访问过的键；再次写入应正常淘汰最旧的空字符串键。
  cache.set("last", "last");
  expect(cache.size()).toBe(2);
  expect(cache.get("")).toBeNull();
  expect(cache.get("new")?.payerAddress).toBe("new");
  expect(cache.get("last")?.payerAddress).toBe("last");
});

test("replacing an empty auth key preserves another live cache entry", () => {
  const cache = new PaymentAuthCache(60000, 2);
  cache.set("", "before");
  cache.set("other", "other");
  cache.set("", "after");

  expect(cache.size()).toBe(2);
  expect(cache.get("")?.payerAddress).toBe("after");
  expect(cache.get("other")?.payerAddress).toBe("other");
});
