export function sanitizeString(input: unknown): string {
  if (typeof input !== "string") return "";
  return input.replace(/\0/g, "").trim();
}

export function isValidEvmAddress(address: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(address);
}

export function validateSettlementPayload(payload: any): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { valid: false, errors: ["Request body must be a JSON object"] };
  }

  const payer = sanitizeString(payload.payer);
  if (!payer || !isValidEvmAddress(payer)) {
    errors.push("Payer must be a valid 20-byte EVM hex address");
  }

  if (
    typeof payload.amount !== "number" ||
    !Number.isFinite(payload.amount) ||
    payload.amount <= 0
  ) {
    errors.push("Amount must be a positive number");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
