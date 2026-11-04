import { describe, it, expect } from "bun:test";
import { ReceiptStore } from "../src/receipt-store.js";

describe("ReceiptStore", () => {
  it("stores and retrieves receipts by txHash and payerAddress", () => {
    const store = new ReceiptStore();
    store.saveReceipt({
      txHash: "0x111",
      requestId: "req-1",
      payerAddress: "0xAlice",
      recipientAddress: "0xProvider",
      amountAtomic: 10_000_000n,
      network: "kite-mainnet",
      timestampMs: 1000,
    });

    store.saveReceipt({
      txHash: "0x222",
      requestId: "req-2",
      payerAddress: "0xAlice",
      recipientAddress: "0xProvider",
      amountAtomic: 5_000_000n,
      network: "kite-mainnet",
      timestampMs: 2000,
    });

    expect(store.size()).toBe(2);
    expect(store.getByTxHash("0x111")?.requestId).toBe("req-1");

    const aliceReceipts = store.getByPayer("0xalice");
    expect(aliceReceipts.length).toBe(2);
    expect(aliceReceipts[0]?.txHash).toBe("0x222"); // sorted newest first

    expect(store.getPayerVolume("0xalice")).toBe(15_000_000n);
  });

  it("handles capacity eviction correctly", () => {
    const store = new ReceiptStore({ maxEntries: 2 });
    store.saveReceipt({
      txHash: "0x1",
      requestId: "r1",
      payerAddress: "0xP1",
      recipientAddress: "0xS",
      amountAtomic: 100n,
      network: "test",
      timestampMs: 1,
    });
    store.saveReceipt({
      txHash: "0x2",
      requestId: "r2",
      payerAddress: "0xP1",
      recipientAddress: "0xS",
      amountAtomic: 200n,
      network: "test",
      timestampMs: 2,
    });
    store.saveReceipt({
      txHash: "0x3",
      requestId: "r3",
      payerAddress: "0xP1",
      recipientAddress: "0xS",
      amountAtomic: 300n,
      network: "test",
      timestampMs: 3,
    });

    expect(store.size()).toBe(2);
    expect(store.getByTxHash("0x1")).toBeUndefined();
    expect(store.getByTxHash("0x3")).toBeDefined();
  });
});
