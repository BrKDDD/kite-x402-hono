import { describe, expect, test } from "bun:test";
import { ReceiptStore, type StoredReceipt } from "../src/receipt-store.js";

const NOW = Date.now();
const SVC = "0xService";

function receipt(i: number, at = NOW): StoredReceipt {
  return {
    txHash: `0x${i.toString(16).padStart(8, "0")}`,
    requestId: `r${i}`,
    payerAddress: `0x${(i % 50).toString(16).padStart(4, "0")}`,
    recipientAddress: SVC,
    amountAtomic: BigInt(i + 1),
    network: "eip155:2368",
    timestampMs: at,
  };
}

describe("ReceiptStore cleanup does not scale with retained entries", () => {
  test("read cost stays flat as the store fills", () => {
    const small = new ReceiptStore({
      maxEntries: 6_000,
      retentionMs: 7 * 24 * 3600_000,
    });
    const large = new ReceiptStore({
      maxEntries: 6_000,
      retentionMs: 7 * 24 * 3600_000,
    });
    for (let i = 0; i < 100; i++) small.saveReceipt(receipt(i));
    for (let i = 0; i < 5_000; i++) large.saveReceipt(receipt(i));

    const ops = 2_000;
    const measure = (store: ReceiptStore) => {
      const start = Bun.nanoseconds();
      for (let i = 0; i < ops; i++)
        store.getByTxHash(`0x${(i % 100).toString(16).padStart(8, "0")}`);
      return Bun.nanoseconds() - start;
    };

    // Warm both up so JIT does not favour one branch.
    measure(small);
    measure(large);
    const smallNs = measure(small);
    const largeNs = measure(large);

    // With a full scan the 50x larger store costs ~50x more. A constant-time
    // lookup keeps the ratio near 1 with generous headroom for CI noise.
    expect(largeNs).toBeLessThan(smallNs * 5);
  });

  test("retention still removes expired entries on every read path", () => {
    const store = new ReceiptStore({ retentionMs: 100 });
    store.saveReceipt({ ...receipt(1, NOW - 200), txHash: "0xby-hash" });
    store.saveReceipt({ ...receipt(2, NOW - 200), txHash: "0x-by-payer" });
    store.saveReceipt({ ...receipt(3, NOW - 200), txHash: "0x-by-size" });

    // Each public read must observe expiry, not just getByTxHash.
    expect(store.getByTxHash("0xby-hash")).toBeUndefined();
    expect(store.getByPayer("0x0001")).toEqual([]);
    expect(store.size()).toBe(0);
  });

  test("a save overwrites the same txHash without duplicating its expiry entry", () => {
    const store = new ReceiptStore({ retentionMs: 100 });
    store.saveReceipt({
      ...receipt(1, NOW),
      txHash: "0xdup",
      requestId: "old",
    });
    store.saveReceipt({
      ...receipt(2, NOW + 10_000),
      txHash: "0xdup",
      requestId: "new",
    });

    // Old copy had expired; the replacement is future-dated and must survive.
    expect(store.getByTxHash("0xdup")?.requestId).toBe("new");
    expect(store.size()).toBe(1);
  });

  test("out-of-order timestamps still expire the earliest receipt first", () => {
    const store = new ReceiptStore({ retentionMs: 100 });
    // Insert newest first, then older ones — the heap must reorder by deadline.
    store.saveReceipt({ ...receipt(1, NOW), txHash: "0xnewest" });
    store.saveReceipt({ ...receipt(2, NOW - 1_000), txHash: "0xoldest" });
    store.saveReceipt({ ...receipt(3, NOW - 500), txHash: "0xmiddle" });

    expect(store.getByTxHash("0xoldest")).toBeUndefined();
    expect(store.getByTxHash("0xmiddle")).toBeUndefined();
    expect(store.getByTxHash("0xnewest")?.requestId).toBe("r1");
  });

  test("overwriting the earliest-deadline receipt leaves no stale heap root", () => {
    const store = new ReceiptStore({ retentionMs: 100 });
    store.saveReceipt({ ...receipt(9, NOW - 1_000), txHash: "0xroot" });
    // Same key, fresh timestamp: the old (expired) heap entry must be removed.
    store.saveReceipt({
      ...receipt(9, NOW + 10_000),
      txHash: "0xroot",
      requestId: "replacement",
    });

    expect(store.getByTxHash("0xroot")?.requestId).toBe("replacement");
    expect(store.size()).toBe(1);
  });
});
