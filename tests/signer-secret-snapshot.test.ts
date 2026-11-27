import { describe, expect, test } from "bun:test";
import { ResponseSigner } from "../src/response-signer.js";

// 仅为本地 HMAC 测试文本，不是钱包私钥或真实支付凭证。
const secret = "local-receipt-fixture-secret-with-32-bytes";

describe("signer construction secret ownership", () => {
  test("a getter is read once and the installed key is the validated key", () => {
    let reads = 0;
    const signer = new ResponseSigner({
      get signingSecret() {
        return ++reads <= 2 ? secret : "weak";
      },
    });
    const { receipt } = signer.signReceipt(
      "fixture-tx",
      "fixture-request",
      200,
      "fixture-body",
    );
    expect(
      new ResponseSigner({ signingSecret: secret }).verifyReceipt(
        receipt,
        "fixture-body",
      ),
    ).toBe(true);
    expect(reads).toBe(1);
  });

  test("validation uses the first value even if a later read would be weak", () => {
    let reads = 0;
    const signer = new ResponseSigner({
      get signingSecret() {
        return ++reads === 1 ? secret : "weak";
      },
    });
    const { receipt } = signer.signReceipt(
      "fixture-tx",
      "fixture-request",
      200,
      "fixture-body",
    );
    expect(
      new ResponseSigner({ signingSecret: secret }).verifyReceipt(
        receipt,
        "fixture-body",
      ),
    ).toBe(true);
    expect(reads).toBe(1);
  });

  test("an initially weak key remains rejected without consulting another value", () => {
    let reads = 0;
    expect(
      () =>
        new ResponseSigner({
          get signingSecret() {
            reads++;
            return "weak";
          },
        }),
    ).toThrow("at least 32 bytes");
    expect(reads).toBe(1);
  });

  test("prototype accessors and ordinary options retain compatibility", () => {
    const options = Object.create({
      get signingSecret() {
        return secret;
      },
    });
    const signer = new ResponseSigner(options);
    const { receipt } = signer.signReceipt(
      "fixture-tx",
      "fixture-request",
      200,
      "fixture-body",
    );
    expect(signer.verifyReceipt(receipt, "fixture-body")).toBe(true);
    expect(signer.verifyReceipt(receipt, "changed-body")).toBe(false);
  });
});
