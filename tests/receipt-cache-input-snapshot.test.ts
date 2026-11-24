import { expect, test } from "bun:test";
import {
  ReceiptMemoryCache,
  type CachedReceipt,
} from "../src/services/receiptMemoryCache.js";

function receipt(overrides: Partial<CachedReceipt> = {}): CachedReceipt {
  return {
    receiptId: "r",
    payer: "alice",
    amount: 1n,
    timestamp: 0,
    ...overrides,
  };
}

test("each supported getter is read once and the validated values are retained", () => {
  const cache = new ReceiptMemoryCache();
  const reads = { receiptId: 0, payer: 0, amount: 0, timestamp: 0 };
  cache.set("r", {
    get receiptId() {
      reads.receiptId++;
      return "r";
    },
    get payer() {
      return ++reads.payer === 1 ? "alice" : "";
    },
    get amount() {
      return ++reads.amount === 1 ? 1n : -1n;
    },
    get timestamp() {
      return ++reads.timestamp === 1 ? 0 : NaN;
    },
  });
  expect(reads).toEqual({ receiptId: 1, payer: 1, amount: 1, timestamp: 1 });
  expect(cache.get("r")).toEqual(receipt());
});

test("a timestamp getter cannot replace its validated value with NaN", () => {
  const cache = new ReceiptMemoryCache();
  let reads = 0;
  cache.set("r", {
    ...receipt(),
    get timestamp() {
      return ++reads === 1 ? 0 : NaN;
    },
  });
  expect(cache.get("r")?.timestamp).toBe(0);
});

test("a payer getter cannot replace its validated address with an empty value", () => {
  const cache = new ReceiptMemoryCache();
  let reads = 0;
  cache.set("r", {
    ...receipt(),
    get payer() {
      return ++reads === 1 ? "alice" : "";
    },
  });
  expect(cache.get("r")?.payer).toBe("alice");
});

test("an invalid first amount is rejected without evicting a live receipt", () => {
  const cache = new ReceiptMemoryCache(1000, 1);
  cache.set("old", receipt({ receiptId: "old" }));
  let reads = 0;
  // 后续读取变成合法值，也不能洗掉首次快照中的负金额。
  expect(() =>
    cache.set("r", {
      ...receipt(),
      get amount() {
        return ++reads === 1 ? -1n : 1n;
      },
    }),
  ).toThrow("Invalid receipt or TTL");
  expect(reads).toBe(1);
  expect(cache.get("r")).toBeNull();
  expect(cache.get("old")?.receiptId).toBe("old");
});

test("ordinary receipts retain caller and return-value isolation", () => {
  const cache = new ReceiptMemoryCache();
  const input = receipt({ amount: "340282366920938463463374607431768211455" });
  cache.set("r", input);
  input.payer = "changed";
  const output = cache.get("r")!;
  output.payer = "changed again";
  expect(cache.get("r")?.payer).toBe("alice");
  expect(cache.get("r")?.amount).toBe(
    "340282366920938463463374607431768211455",
  );
});

test("unsupported getters are not evaluated and live LRU admission stays intact", () => {
  const cache = new ReceiptMemoryCache(1000, 2);
  const input = {
    ...receipt(),
    get extra() {
      throw new Error("not a receipt field");
    },
  };
  cache.set("r", input);
  cache.set("s", receipt({ receiptId: "s" }));
  cache.get("r");
  cache.set("t", receipt({ receiptId: "t" }));
  expect(cache.has("s")).toBe(false);
  expect(cache.has("r")).toBe(true);
  expect(cache.has("t")).toBe(true);
});
