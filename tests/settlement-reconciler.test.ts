import { describe, expect, test } from "bun:test";
import { SettlementReconciler } from "../src/settlement-reconciler.js";

describe("settlement-reconciler", () => {
  const receipt1 = {
    txHash: "0xaaaa1111",
    payer: "0x1111111111111111111111111111111111111111",
    payTo: "0x2222222222222222222222222222222222222222",
    amount: "1000",
    network: "kite-testnet",
    timestamp: 1000,
    success: true,
  };

  const receipt2 = {
    txHash: "0xbbbb2222",
    payer: "0x1111111111111111111111111111111111111111",
    payTo: "0x2222222222222222222222222222222222222222",
    amount: "2500",
    network: "kite-testnet",
    timestamp: 2000,
    success: true,
  };

  const receiptFailed = {
    txHash: "0xcccc3333",
    payer: "0x3333333333333333333333333333333333333333",
    payTo: "0x2222222222222222222222222222222222222222",
    amount: "500",
    network: "kite-testnet",
    timestamp: 3000,
    success: false,
    errorReason: "insufficient_balance",
  };

  test("records and retrieves receipts by txHash and payer", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record(receipt1);
    reconciler.record(receipt2);
    reconciler.record(receiptFailed);

    expect(reconciler.size()).toBe(3);
    expect(reconciler.getByTxHash("0xAAAA1111")?.amount).toBe("1000");

    const payer1Receipts = reconciler.getByPayer(
      "0x1111111111111111111111111111111111111111",
    );
    expect(payer1Receipts.length).toBe(2);
  });

  test("calculates summary analytics accurately", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record(receipt1);
    reconciler.record(receipt2);
    reconciler.record(receiptFailed);

    const summary = reconciler.getSummary();
    expect(summary.successfulSettlements).toBe(2);
    expect(summary.failedSettlements).toBe(1);
    expect(summary.totalSettledAmount).toBe(3500n);
    expect(summary.uniquePayersCount).toBe(2);
  });

  test("queries with filters and limits", () => {
    const reconciler = new SettlementReconciler();
    reconciler.record(receipt1);
    reconciler.record(receipt2);
    reconciler.record(receiptFailed);

    const failed = reconciler.query({ success: false });
    expect(failed.length).toBe(1);
    expect(failed[0]?.txHash).toBe("0xcccc3333");

    const limited = reconciler.query({ limit: 1 });
    expect(limited.length).toBe(1);
  });
});
