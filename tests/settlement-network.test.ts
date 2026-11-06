import { expect, test } from "bun:test";
import {
  SettlementReconciler,
  type SettlementReceipt,
} from "../src/settlement-reconciler.js";
const receipt = (network: string, txHash = "0xabc"): SettlementReceipt => ({
  txHash,
  payer: "payer",
  payTo: "merchant",
  amount: "7",
  network,
  timestamp: 1,
  success: true,
});

test("an inferred network rejects another chain even when the transaction hash matches", () => {
  const store = new SettlementReconciler();
  store.record(receipt("eip155:2368"));
  expect(() => store.record(receipt("eip155:2366"))).toThrow("network");
  expect(store.size()).toBe(1);
  expect(store.getSummary().totalSettledAmount).toBe(7n);
  expect(store.getByTxHash("0xabc")?.network).toBe("eip155:2368");
});

test("mismatched writes cannot evict the only receipt", () => {
  const store = new SettlementReconciler(1, "eip155:2368");
  store.record(receipt("eip155:2368"));
  expect(() => store.record(receipt("eip155:2366", "0xdef"))).toThrow(
    "network",
  );
  expect(store.getByTxHash("0xabc")).toBeDefined();
  store.clear();
  expect(() => store.record(receipt("eip155:2366"))).toThrow("network");
  store.record(receipt("eip155:2368", "0xdef"));
  expect(store.size()).toBe(1);
});

test("separate network instances can retain the same hash without mixing totals", () => {
  const testnet = new SettlementReconciler(10, "eip155:2368");
  const mainnet = new SettlementReconciler(10, "eip155:2366");
  testnet.record(receipt("eip155:2368"));
  mainnet.record(receipt("eip155:2366"));
  expect(testnet.getSummary().totalSettledAmount).toBe(7n);
  expect(mainnet.getSummary().totalSettledAmount).toBe(7n);
});

test("invalid network writes do not bind an empty instance", () => {
  expect(() => new SettlementReconciler(10, " ")).toThrow();
  const store = new SettlementReconciler();
  expect(() => store.record(receipt(""))).toThrow();
  store.record(receipt("eip155:2368"));
  expect(store.size()).toBe(1);
});
