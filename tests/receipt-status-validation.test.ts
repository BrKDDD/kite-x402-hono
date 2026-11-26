import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  ResponseSigner,
  type ResponseReceipt,
} from "../src/response-signer.js";

const secret = "synthetic-receipt-status-secret-32-characters";
const signer = new ResponseSigner({ signingSecret: secret });
const body = "fixture";

function legacyReceipt(statusCode: unknown): ResponseReceipt {
  const receipt: ResponseReceipt = {
    paymentTxHash: "test-tx",
    requestId: "test-request",
    timestampMs: Date.now(),
    statusCode: statusCode as number,
    bodyHash: signer.hashContent(body),
    signature: "",
  };
  // 独立生成旧版 MAC：即便签名匹配，非 HTTP 状态元数据也不能被认证为合法回执。
  receipt.signature =
    "hmac_" +
    createHmac("sha256", secret)
      .update(
        JSON.stringify([
          "kite-receipt-v1",
          "kite-receipt-k1",
          receipt.paymentTxHash,
          receipt.requestId,
          statusCode,
          receipt.bodyHash,
          receipt.timestampMs,
        ]),
      )
      .digest("hex");
  return receipt;
}

const invalidNumbers = [
  NaN,
  Infinity,
  -Infinity,
  0,
  99,
  600,
  200.5,
  Number.MAX_SAFE_INTEGER,
];

test("signing rejects non-finite, fractional and out-of-range HTTP statuses", () => {
  for (const status of invalidNumbers)
    expect(() =>
      signer.signReceipt("test-tx", "test-request", status, body),
    ).toThrow();
});

test("verification rejects malformed statuses even with a correct legacy MAC", () => {
  for (const status of [...invalidNumbers, null, undefined, "200", false])
    expect(signer.verifyReceipt(legacyReceipt(status), body)).toBe(false);
});

test("NaN, infinity and JSON null aliases cannot authenticate a malformed receipt", () => {
  const receipt = legacyReceipt(NaN);
  expect(signer.verifyReceipt(receipt, body)).toBe(false);
  expect(signer.verifyReceipt({ ...receipt, statusCode: Infinity }, body)).toBe(
    false,
  );
  expect(signer.verifyReceipt(JSON.parse(JSON.stringify(receipt)), body)).toBe(
    false,
  );
});

test("valid boundary and custom HTTP statuses keep v1 MAC compatibility", () => {
  for (const status of [100, 199, 200, 204, 299, 302, 402, 471, 500, 599]) {
    const external = legacyReceipt(status);
    expect(signer.verifyReceipt(external, body)).toBe(true);
    const { receipt } = signer.signReceipt(
      "test-tx",
      "test-request",
      status,
      body,
    );
    expect(signer.verifyReceipt(receipt, body)).toBe(true);
    // 状态变为另一个合法值仍属于篡改，不能复用原签名。
    expect(
      signer.verifyReceipt(
        { ...receipt, statusCode: status === 200 ? 201 : 200 },
        body,
      ),
    ).toBe(false);
  }
});
