import { expect, test } from "bun:test";
import { ReceiptStore, type StoredReceipt } from "../src/receipt-store.js";

const now = 1_000_000;
const retentionMs = 1000;
const receipt = (
  txHash: string,
  timestampMs = now,
  payerAddress = "0xAlice",
): StoredReceipt => ({
  txHash,
  requestId: txHash,
  payerAddress,
  recipientAddress: "0xMerchant",
  amountAtomic: 10n,
  network: "eip155:2368",
  timestampMs,
});

function withClock(run: () => void): void {
  const original = Date.now;
  Date.now = () => now;
  try {
    run();
  } finally {
    Date.now = original;
  }
}

for (const age of [retentionMs, retentionMs + 1]) {
  test(`expired import at age ${age} does not evict a live receipt`, () => {
    withClock(() => {
      const store = new ReceiptStore({ maxEntries: 1, retentionMs });
      store.saveReceipt(receipt("0xLive"));
      // 历史回执到达时已超出保留期，不应挤掉仍可用于查询的付款记录。
      store.saveReceipt(receipt("0xOld", now - age, "0xBob"));
      expect(store.getByTxHash("0xLive")?.requestId).toBe("0xLive");
      expect(store.getByTxHash("0xOld")).toBeUndefined();
      expect(store.getByPayer("0xAlice")).toHaveLength(1);
      expect(store.getByPayer("0xBob")).toEqual([]);
      expect(store.getPayerVolume("0xAlice")).toBe(10n);
      expect(store.size()).toBe(1);
    });
  });
}

test("expired replacement removes only its transaction and payer index", () => {
  withClock(() => {
    const store = new ReceiptStore({ maxEntries: 2, retentionMs });
    store.saveReceipt(receipt("0xOther"));
    store.saveReceipt(receipt("0xSame"));
    store.saveReceipt(receipt("0xSAME", now - retentionMs, "0xBob"));
    // 同交易的过期覆盖仍使旧版本失效，不得波及其他交易或留下付款方索引。
    expect(store.getByTxHash("0xsame")).toBeUndefined();
    expect(store.getByTxHash("0xOther")).toBeDefined();
    expect(store.getByPayer("0xAlice")).toHaveLength(1);
    expect(store.getPayerVolume("0xAlice")).toBe(10n);
    expect(store.getByPayer("0xBob")).toEqual([]);
    expect(store.size()).toBe(1);
  });
});

test("unexpired imports still replace and evict in FIFO order", () => {
  withClock(() => {
    const store = new ReceiptStore({ maxEntries: 2, retentionMs });
    store.saveReceipt(receipt("0xFirst"));
    store.saveReceipt(receipt("0xSecond"));
    store.saveReceipt(receipt("0xFIRST", now - retentionMs + 1, "0xBob"));
    store.saveReceipt(receipt("0xThird"));
    expect(store.getByTxHash("0xSecond")).toBeUndefined();
    expect(store.getByTxHash("0xFirst")?.payerAddress).toBe("0xbob");
    expect(store.getByPayer("0xBob")).toHaveLength(1);
    expect(store.getByPayer("0xAlice")).toHaveLength(1);
    expect(store.size()).toBe(2);
  });
});
