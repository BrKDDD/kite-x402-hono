import { describe, expect, test } from "bun:test";
import {
  decodePaymentSignature,
  validateAuthorizationWindow,
} from "../src/signature-decoder.js";

describe("signature-decoder", () => {
  const sampleAuth = {
    from: "0x1111111111111111111111111111111111111111",
    to: "0x2222222222222222222222222222222222222222",
    value: "1000",
    validAfter: 1000,
    validBefore: 2000,
    nonce: "0xabcdef123456",
  };

  const samplePayload = {
    x402Version: 2,
    scheme: "exact",
    network: "kite-testnet",
    payload: {
      asset: "0x3333333333333333333333333333333333333333",
      authorization: sampleAuth,
      signature: "0x9999",
    },
  };

  test("decodes base64-encoded payment signature", () => {
    const rawBase64 = Buffer.from(JSON.stringify(samplePayload)).toString("base64");
    const decoded = decodePaymentSignature(rawBase64);

    expect(decoded.x402Version).toBe(2);
    expect(decoded.scheme).toBe("exact");
    expect(decoded.network).toBe("kite-testnet");
    expect(decoded.asset).toBe("0x3333333333333333333333333333333333333333");
    expect(decoded.authorization?.from).toBe("0x1111111111111111111111111111111111111111");
    expect(decoded.authorization?.nonce).toBe("0xabcdef123456");
  });

  test("validates authorization within active validity window", () => {
    const res = validateAuthorizationWindow(sampleAuth, { nowSeconds: 1500 });
    expect(res.isValid).toBe(true);
    expect(res.payer).toBe("0x1111111111111111111111111111111111111111");
    expect(res.nonce).toBe("0xabcdef123456");
  });

  test("rejects expired authorization past validBefore", () => {
    const res = validateAuthorizationWindow(sampleAuth, { nowSeconds: 2100 });
    expect(res.isValid).toBe(false);
    expect(res.reason).toBe("authorization_expired");
  });

  test("rejects authorization not yet active before validAfter", () => {
    const res = validateAuthorizationWindow(sampleAuth, { nowSeconds: 900 });
    expect(res.isValid).toBe(false);
    expect(res.reason).toBe("authorization_not_yet_valid");
  });

  test("rejects inverted validity windows", () => {
    const inverted = { ...sampleAuth, validAfter: 3000, validBefore: 2000 };
    const res = validateAuthorizationWindow(inverted, { nowSeconds: 2500 });
    expect(res.isValid).toBe(false);
    expect(res.reason).toBe("inverted_validity_window");
  });
});
