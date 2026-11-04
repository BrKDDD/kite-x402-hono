import { describe, it, expect } from "bun:test";
import { ResponseSigner } from "../src/response-signer.js";

describe("ResponseSigner", () => {
  const secret = "test-super-secret-key-123";

  it("signs a response receipt and produces formatted header value", () => {
    const signer = new ResponseSigner({ signingSecret: secret });
    const { receipt, headerValue } = signer.signReceipt(
      "0xtx123",
      "req-456",
      200,
      '{"status":"ok","data":"hello"}',
    );

    expect(receipt.paymentTxHash).toBe("0xtx123");
    expect(receipt.requestId).toBe("req-456");
    expect(receipt.statusCode).toBe(200);
    expect(headerValue).toContain('tx="0xtx123"');
    expect(headerValue).toContain('sig="');
  });

  it("successfully verifies valid response receipt", () => {
    const signer = new ResponseSigner({ signingSecret: secret });
    const body = '{"inference":"ai result"}';
    const { receipt } = signer.signReceipt("0xtx789", "req-001", 200, body);

    const isValid = signer.verifyReceipt(receipt, body);
    expect(isValid).toBe(true);
  });

  it("rejects receipt when response body has been tampered with", () => {
    const signer = new ResponseSigner({ signingSecret: secret });
    const originalBody = '{"result":100}';
    const tamperedBody = '{"result":999}';
    const { receipt } = signer.signReceipt(
      "0xtx789",
      "req-001",
      200,
      originalBody,
    );

    const isValid = signer.verifyReceipt(receipt, tamperedBody);
    expect(isValid).toBe(false);
  });

  it("rejects receipt with incorrect signing secret", () => {
    const signerA = new ResponseSigner({ signingSecret: secret });
    const signerB = new ResponseSigner({
      signingSecret: "different-secret-999",
    });
    const body = '{"status":"success"}';
    const { receipt } = signerA.signReceipt("0xtx789", "req-001", 200, body);

    const isValid = signerB.verifyReceipt(receipt, body);
    expect(isValid).toBe(false);
  });
});
