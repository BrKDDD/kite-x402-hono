/**
 * Offline EIP-712 & EIP-3009 payment signature inspector and schema validator.
 * Enables zero-latency inspection and pre-flight validation of incoming
 * PAYMENT-SIGNATURE credentials before upstream proxying or remote facilitator calls.
 */

export interface EIP3009Authorization {
  from: string;
  to: string;
  value: string | number | bigint;
  validAfter: number | string;
  validBefore: number | string;
  nonce: string;
  v?: number | undefined;
  r?: string | undefined;
  s?: string | undefined;
}

export interface DecodedPaymentPayload {
  x402Version?: number | undefined;
  scheme?: string | undefined;
  network?: string | undefined;
  asset?: string | undefined;
  authorization?: EIP3009Authorization | undefined;
  signature?: string | undefined;
  rawJson: Record<string, unknown>;
}

export interface ValidationWindowOptions {
  /** Maximum allowable clock drift between client and server in seconds. Default: 30 */
  maxDriftSeconds?: number | undefined;
  /** Current epoch time in seconds (defaults to Date.now() / 1000). */
  nowSeconds?: number | undefined;
}

export interface SignatureValidationResult {
  isValid: boolean;
  reason?: string | undefined;
  payer?: string | undefined;
  payTo?: string | undefined;
  nonce?: string | undefined;
  validAfter?: number | undefined;
  validBefore?: number | undefined;
}

/**
 * Decodes a base64 encoded PAYMENT-SIGNATURE or X-PAYMENT header into a structured payload.
 */
export function decodePaymentSignature(
  rawHeader: string,
): DecodedPaymentPayload {
  if (!rawHeader || typeof rawHeader !== "string") {
    throw new Error("Missing or invalid payment signature header string");
  }

  let jsonStr: string;
  try {
    jsonStr = Buffer.from(rawHeader.trim(), "base64").toString("utf-8");
  } catch {
    throw new Error("Failed to base64-decode payment signature header");
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error("Decoded payment signature payload is not valid JSON");
  }

  const payloadObj = (
    parsed.payload && typeof parsed.payload === "object"
      ? parsed.payload
      : parsed
  ) as Record<string, unknown>;

  const auth = (
    payloadObj.authorization && typeof payloadObj.authorization === "object"
      ? payloadObj.authorization
      : undefined
  ) as EIP3009Authorization | undefined;

  return {
    x402Version:
      typeof parsed.x402Version === "number" ? parsed.x402Version : undefined,
    scheme: typeof parsed.scheme === "string" ? parsed.scheme : undefined,
    network: typeof parsed.network === "string" ? parsed.network : undefined,
    asset: typeof payloadObj.asset === "string" ? payloadObj.asset : undefined,
    authorization: auth,
    signature:
      typeof payloadObj.signature === "string"
        ? payloadObj.signature
        : undefined,
    rawJson: parsed,
  };
}

/**
 * Validates the time window of an EIP-3009 authorization against current server clock.
 */
export function validateAuthorizationWindow(
  auth: EIP3009Authorization,
  options: ValidationWindowOptions = {},
): SignatureValidationResult {
  const maxDrift = options.maxDriftSeconds ?? 30;
  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  const validAfter = Number(auth.validAfter);
  const validBefore = Number(auth.validBefore);

  if (Number.isNaN(validAfter) || Number.isNaN(validBefore)) {
    return {
      isValid: false,
      reason: "invalid_timestamp_format",
    };
  }

  if (validAfter > validBefore) {
    return {
      isValid: false,
      reason: "inverted_validity_window",
      validAfter,
      validBefore,
    };
  }

  // Not yet valid (allowing clock drift tolerance)
  if (validAfter > now + maxDrift) {
    return {
      isValid: false,
      reason: "authorization_not_yet_valid",
      validAfter,
      validBefore,
    };
  }

  // Expired (allowing clock drift tolerance)
  if (validBefore < now - maxDrift) {
    return {
      isValid: false,
      reason: "authorization_expired",
      validAfter,
      validBefore,
    };
  }

  return {
    isValid: true,
    payer: auth.from,
    payTo: auth.to,
    nonce: auth.nonce,
    validAfter,
    validBefore,
  };
}
