import { afterEach, expect, mock, spyOn, test } from "bun:test";
import {
  ResponseSigner,
  type ResponseReceipt,
} from "../src/response-signer.js";
const signer = new ResponseSigner({
  signingSecret: "local-test-fixture-secret-0123456789abcdef",
});
afterEach(() => mock.restore());
function signedAt(at: number) {
  const clock = spyOn(Date, "now").mockReturnValue(at);
  return {
    clock,
    receipt: signer.signReceipt("tx", "request", 200, "body").receipt,
  };
}

test("a changing timestamp cannot make an expired signature pass a fresh TTL check", () => {
  const { clock, receipt } = signedAt(1000);
  clock.mockReturnValue(1000000);
  let reads = 0;
  // 旧实现前三次用新时间通过检查，第四次用旧时间匹配已过期的签名。
  const changing = {
    ...receipt,
    get timestampMs() {
      return ++reads <= 3 ? 1000000 : 1000;
    },
  };
  expect(signer.verifyReceipt(changing, "body", 100)).toBe(false);
  expect(reads).toBe(1);
});

test("each receipt field is read once for validation and MAC comparison", () => {
  const { receipt } = signedAt(1000);
  const reads = new Map<string, number>();
  const input = Object.fromEntries(
    Object.keys(receipt).map((key) => [key, undefined]),
  ) as unknown as ResponseReceipt;
  for (const key of Object.keys(receipt) as (keyof ResponseReceipt)[]) {
    Object.defineProperty(input, key, {
      get() {
        reads.set(key, (reads.get(key) ?? 0) + 1);
        return receipt[key];
      },
    });
  }
  expect(signer.verifyReceipt(input, "body")).toBe(true);
  expect([...reads.values()]).toEqual([1, 1, 1, 1, 1, 1]);
});

test("a valid first signature is not replaced between format and constant-time comparison", () => {
  const { receipt } = signedAt(1000);
  let reads = 0;
  const input = {
    ...receipt,
    get signature() {
      return ++reads === 1 ? receipt.signature : "short";
    },
  };
  expect(signer.verifyReceipt(input, "body")).toBe(true);
  expect(reads).toBe(1);
});

test("normal receipts retain exact age, future-time and body integrity checks", () => {
  const { clock, receipt } = signedAt(1000);
  clock.mockReturnValue(1100);
  expect(signer.verifyReceipt(receipt, "body", 100)).toBe(true);
  clock.mockReturnValue(1101);
  expect(signer.verifyReceipt(receipt, "body", 100)).toBe(false);
  clock.mockReturnValue(999);
  expect(signer.verifyReceipt(receipt, "body")).toBe(false);
  clock.mockReturnValue(1000);
  expect(signer.verifyReceipt(receipt, "changed")).toBe(false);
});

test("invalid status and signature values remain rejected", () => {
  const { receipt } = signedAt(1000);
  expect(signer.verifyReceipt({ ...receipt, statusCode: NaN }, "body")).toBe(
    false,
  );
  expect(
    signer.verifyReceipt({ ...receipt, signature: "invalid" }, "body"),
  ).toBe(false);
});
