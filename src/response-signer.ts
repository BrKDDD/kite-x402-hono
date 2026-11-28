import { createHash, createHmac, timingSafeEqual } from "node:crypto";
/**
 * Cryptographic Receipt & Response Attestation Signer for x402 payment responses.
 * Provides shared-secret integrity authentication of HTTP response metadata
 * and settled transaction proofs.
 */

export interface ResponseReceipt {
  paymentTxHash: string;
  requestId: string;
  timestampMs: number;
  statusCode: number;
  bodyHash: string;
  signature: string;
}

export interface ResponseSignerOptions {
  signingSecret: string;
  keyId?: string;
}

// JSON 会把非有限数编码为 null；签名和验证须共同约束状态，避免不同值共用 MAC。
function isHttpStatusCode(status: number): boolean {
  return Number.isInteger(status) && status >= 100 && status <= 599;
}

export class ResponseSigner {
  private secret: string;
  private keyId: string;

  constructor(options: ResponseSignerOptions) {
    if (
      !options.signingSecret ||
      Buffer.byteLength(options.signingSecret) < 32
    ) {
      throw new Error("signingSecret must be at least 32 bytes");
    }
    this.secret = options.signingSecret;
    this.keyId = options.keyId ?? "kite-receipt-k1";
  }

  /**
   * Generates a deterministic hash of the response payload.
   */
  public hashContent(content: string): string {
    return "0x" + createHash("sha256").update(content).digest("hex");
  }

  /**
   * Signs response receipt and returns structured receipt object and header value.
   */
  public signReceipt(
    paymentTxHash: string,
    requestId: string,
    statusCode: number,
    responseBody: string,
  ): { receipt: ResponseReceipt; headerValue: string } {
    if (!isHttpStatusCode(statusCode))
      throw new Error("Invalid receipt HTTP status");
    if (
      ![paymentTxHash, requestId, this.keyId].every((v) =>
        /^[A-Za-z0-9_.:~-]{1,256}$/.test(v),
      )
    )
      throw new Error("Invalid receipt identifier");
    const timestampMs = Date.now();
    const bodyHash = this.hashContent(responseBody);
    const signature = this.mac(
      paymentTxHash,
      requestId,
      statusCode,
      bodyHash,
      timestampMs,
    );

    const receipt: ResponseReceipt = {
      paymentTxHash,
      requestId,
      timestampMs,
      statusCode,
      bodyHash,
      signature,
    };

    const headerValue = `keyId="${this.keyId}", tx="${paymentTxHash}", req="${requestId}", ts="${timestampMs}", bhash="${bodyHash}", sig="${signature}"`;

    return { receipt, headerValue };
  }

  /**
   * Verifies receipt authenticity.
   */
  public verifyReceipt(
    receipt: ResponseReceipt,
    responseBody: string,
    maxAgeMs: number = 300_000,
  ): boolean {
    // getter 可能逐次变化；时效、内容和 MAC 必须基于同一份回执快照。
    const snapshot: ResponseReceipt = {
      paymentTxHash: receipt.paymentTxHash,
      requestId: receipt.requestId,
      timestampMs: receipt.timestampMs,
      statusCode: receipt.statusCode,
      bodyHash: receipt.bodyHash,
      signature: receipt.signature,
    };
    const now = Date.now();
    if (
      !isHttpStatusCode(snapshot.statusCode) ||
      !Number.isFinite(maxAgeMs) ||
      maxAgeMs < 0 ||
      !Number.isSafeInteger(snapshot.timestampMs) ||
      snapshot.timestampMs > now ||
      now - snapshot.timestampMs > maxAgeMs
    ) {
      return false; // 状态或时效不合法时，不能认证为有效回执。
    }

    const computedBodyHash = this.hashContent(responseBody);
    if (computedBodyHash !== snapshot.bodyHash) {
      return false; // Body mismatch
    }

    const expected = this.mac(
      snapshot.paymentTxHash,
      snapshot.requestId,
      snapshot.statusCode,
      computedBodyHash,
      snapshot.timestampMs,
    );
    if (!/^hmac_[a-f0-9]{64}$/.test(snapshot.signature)) return false;
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(snapshot.signature),
    );
  }
  private mac(
    tx: string,
    requestId: string,
    status: number,
    hash: string,
    time: number,
  ): string {
    return (
      "hmac_" +
      createHmac("sha256", this.secret)
        .update(
          JSON.stringify([
            "kite-receipt-v1",
            this.keyId,
            tx,
            requestId,
            status,
            hash,
            time,
          ]),
        )
        .digest("hex")
    );
  }
}
