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
    // 校验和安装同一个密钥值，避免有状态 getter 在校验后替换为短密钥。
    const signingSecret = options.signingSecret;
    if (!signingSecret || Buffer.byteLength(signingSecret) < 32) {
      throw new Error("signingSecret must be at least 32 bytes");
    }
    this.secret = signingSecret;
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
    if (
      !isHttpStatusCode(receipt.statusCode) ||
      !Number.isFinite(maxAgeMs) ||
      maxAgeMs < 0 ||
      !Number.isSafeInteger(receipt.timestampMs) ||
      receipt.timestampMs > Date.now() ||
      Date.now() - receipt.timestampMs > maxAgeMs
    ) {
      return false; // 状态或时效不合法时，不能认证为有效回执。
    }

    const computedBodyHash = this.hashContent(responseBody);
    if (computedBodyHash !== receipt.bodyHash) {
      return false; // Body mismatch
    }

    const expected = this.mac(
      receipt.paymentTxHash,
      receipt.requestId,
      receipt.statusCode,
      computedBodyHash,
      receipt.timestampMs,
    );
    if (!/^hmac_[a-f0-9]{64}$/.test(receipt.signature)) return false;
    return timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(receipt.signature),
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
