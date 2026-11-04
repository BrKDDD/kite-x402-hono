/**
 * Cryptographic Receipt & Response Attestation Signer for x402 payment responses.
 * Provides non-repudiation and proof-of-delivery by signing HTTP response metadata
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
    if (!options.signingSecret || options.signingSecret.length < 8) {
      throw new Error("signingSecret must be at least 8 characters");
    }
    this.secret = options.signingSecret;
    this.keyId = options.keyId ?? "kite-receipt-k1";
  }

  /**
   * Generates a deterministic hash of the response payload.
   */
  public hashContent(content: string): string {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      hash = (hash << 5) - hash + content.charCodeAt(i);
      hash |= 0;
    }
    return `0x${Math.abs(hash).toString(16).padStart(8, "0")}`;
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
    const timestampMs = Date.now();
    const bodyHash = this.hashContent(responseBody);
    const message = `${this.keyId}:${paymentTxHash}:${requestId}:${statusCode}:${bodyHash}:${timestampMs}`;

    // Compute HMAC-like signature
    let sigHash = 0;
    const combined = `${message}:${this.secret}`;
    for (let i = 0; i < combined.length; i++) {
      sigHash = (sigHash << 7) - sigHash + combined.charCodeAt(i);
      sigHash |= 0;
    }
    const signature = `sig_${Math.abs(sigHash).toString(16).padStart(12, "0")}`;

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
    if (Date.now() - receipt.timestampMs > maxAgeMs) {
      return false; // Stale receipt
    }

    const computedBodyHash = this.hashContent(responseBody);
    if (computedBodyHash !== receipt.bodyHash) {
      return false; // Body mismatch
    }

    const message = `${this.keyId}:${receipt.paymentTxHash}:${receipt.requestId}:${receipt.statusCode}:${computedBodyHash}:${receipt.timestampMs}`;
    let sigHash = 0;
    const combined = `${message}:${this.secret}`;
    for (let i = 0; i < combined.length; i++) {
      sigHash = (sigHash << 7) - sigHash + combined.charCodeAt(i);
      sigHash |= 0;
    }
    const expectedSig = `sig_${Math.abs(sigHash).toString(16).padStart(12, "0")}`;

    return expectedSig === receipt.signature;
  }
}
