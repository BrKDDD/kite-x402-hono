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
      !Number.isFinite(maxAgeMs) ||
      maxAgeMs < 0 ||
      !Number.isSafeInteger(receipt.timestampMs) ||
      receipt.timestampMs > Date.now() ||
      Date.now() - receipt.timestampMs > maxAgeMs
    ) {
      return false; // Stale receipt
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
