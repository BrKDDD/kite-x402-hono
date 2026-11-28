import { expect, test } from "bun:test";
import { ResponseCacheStore } from "../src/response-caching.js";

/**
 * A non-cloneable value under an allowlisted header key. Only untyped JS
 * callers can produce this; TypeScript's Record<string,string> forbids it.
 * It models the real failure mode: structuredClone throws on the return copy
 * after the staged state has been committed.
 */
function poisonHeaders(): Record<string, string> {
  return { "content-type": (() => "not cloneable") as unknown as string };
}

function safeHeaders(): Record<string, string> {
  return { "content-type": "application/json" };
}

function expectCloneFailure(fn: () => unknown): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toBeInstanceOf(DOMException);
  expect((thrown as DOMException).name).toBe("DataCloneError");
}

test("a failed replacement leaves the original response intact and cloneable", () => {
  const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });
  cache.set("paid", "original-body", 200, safeHeaders());

  expectCloneFailure(() => cache.set("paid", "poison", 200, poisonHeaders()));
  const retained = cache.get("paid");
  expect(retained?.body).toBe("original-body");
  expect(retained?.headers["content-type"]).toBe("application/json");
});

test("a failed insertion into a full cache does not evict the live response", () => {
  const cache = new ResponseCacheStore({
    defaultTtlSeconds: 60,
    maxEntries: 1,
  });
  cache.set("paid", "original-body", 200, safeHeaders());

  expectCloneFailure(() => cache.set("other", "poison", 200, poisonHeaders()));
  expect(cache.get("paid")?.body).toBe("original-body");
  expect(cache.get("other")).toBeNull();
});

test("a failed replacement preserves FIFO order for the next capacity eviction", () => {
  const cache = new ResponseCacheStore({
    defaultTtlSeconds: 60,
    maxEntries: 2,
  });
  cache.set("first", "1", 200, safeHeaders());
  cache.set("second", "2", 200, safeHeaders());

  // Failed write to "first" must not move it to the eviction tail.
  expectCloneFailure(() => cache.set("first", "poison", 200, poisonHeaders()));
  cache.set("third", "3", 200, safeHeaders());

  expect(cache.get("first")).toBeNull();
  expect(cache.get("second")?.body).toBe("2");
  expect(cache.get("third")?.body).toBe("3");
});

test("a valid write still succeeds after a failed one, with isolated copies", () => {
  const cache = new ResponseCacheStore({
    defaultTtlSeconds: 60,
    maxEntries: 1,
  });
  cache.set("paid", "original", 200, safeHeaders());
  expectCloneFailure(() => cache.set("paid", "poison", 200, poisonHeaders()));

  const headers = { "content-type": "text/plain" };
  const returned = cache.set("paid", "valid", 201, headers);
  returned.body = "mutated";
  returned.headers["content-type"] = "mutated";

  const retained = cache.get("paid");
  expect(retained?.body).toBe("valid");
  expect(retained?.status).toBe(201);
  expect(retained?.headers["content-type"]).toBe("text/plain");
  expect(headers["content-type"]).toBe("text/plain");
});

test("a stored entry is detached from caller-owned objects after a valid write", () => {
  const cache = new ResponseCacheStore({ defaultTtlSeconds: 60 });
  const callerStatus = { code: 200 };
  cache.set("paid", "body", callerStatus as unknown as number);

  // cloneable at set() time, poisoned afterwards through the still-shared
  // reference. The stored entry must not inherit the caller's later mutation.
  (callerStatus as { poison?: () => void }).poison = () => undefined;

  const retained = cache.get("paid");
  expect(retained?.status as unknown).toEqual({ code: 200 });
  expect(retained?.body).toBe("body");
});
