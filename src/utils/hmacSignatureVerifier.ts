import { createHmac, timingSafeEqual } from "node:crypto";
export interface HmacVerificationResult {
  isValid: boolean;
  error?: string;
}

/** Raw payload mode matches WebhookDispatcher. Timestamp mode signs `${timestamp}.${payload}`
 * with a Unix-millisecond timestamp; a timestamp must never be unsigned replay protection.
 * Callers must also deduplicate event IDs to prevent replay inside the tolerance window.
 */
export async function verifyHmacSignature(
  payload: string,
  secret: string,
  signatureHex: string,
  timestampHeader?: string,
  maxToleranceMs = 300000,
): Promise<HmacVerificationResult> {
  if (
    Buffer.byteLength(secret) < 32 ||
    !/^[a-fA-F0-9]{64}$/.test(signatureHex) ||
    !Number.isSafeInteger(maxToleranceMs) ||
    maxToleranceMs < 0
  )
    return { isValid: false, error: "Invalid signature parameters" };
  let message = payload;
  if (timestampHeader !== undefined) {
    const timestamp = Number(timestampHeader);
    if (
      !/^\d+$/.test(timestampHeader) ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(Date.now() - timestamp) > maxToleranceMs
    )
      return { isValid: false, error: "Invalid or expired timestamp" };
    message = `${timestampHeader}.${payload}`;
  }
  const expected = createHmac("sha256", secret).update(message).digest();
  return {
    isValid: timingSafeEqual(expected, Buffer.from(signatureHex, "hex")),
  };
}
export default verifyHmacSignature;
