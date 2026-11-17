/**
 * The single definition of a valid atomic amount for this package.
 *
 * `ReceiptMemoryCache` documented this contract first ("atomic amounts accept
 * bigint, decimal integer strings, or safe integers (uint256 range)"), and
 * `SettlementReconciler` silently disagreed with it: a non-representable amount
 * would be recorded as a successful settlement and then skipped during
 * aggregation, so a settled payment contributed nothing to the reported total.
 * Keeping the rule in one place stops the two from drifting again.
 */

/** Exclusive upper bound: a uint256 cannot represent this value. */
const UINT256_EXCLUSIVE = 1n << 256n;

/**
 * Longest accepted digit string. This is a cost bound, not a range rule: any
 * 79-digit value already exceeds uint256, so the cap cannot reject a valid
 * amount. It is set to the widest bound the receipt cache accepted before this
 * helper existed, so padding with leading zeros keeps working.
 */
const MAX_DIGITS = 256;

/**
 * Parses an atomic amount, returning `null` when it is not representable.
 *
 * A value is representable when it is a non-negative integer below 2^256 that
 * has not already lost precision. That excludes `number` values outside the safe
 * integer range, fractional or exponential decimal strings, and any non-integer
 * `number`; `BigInt(0.05)` throws, which is how the previous aggregation code
 * silently discarded such settlements.
 *
 * Returning `null` instead of throwing lets each caller keep its own error
 * message while sharing one rule.
 *
 * @param amount - Candidate amount in atomic units.
 * @returns The amount as a bigint, or `null` when it is not representable.
 */
export function tryParseAtomicAmount(amount: unknown): bigint | null {
  let value: bigint;
  if (typeof amount === "bigint") {
    value = amount;
  } else if (typeof amount === "number") {
    // A fractional number is not a count of atomic units, and an integer beyond
    // the safe range has already lost the precision needed to interpret it.
    if (!Number.isSafeInteger(amount)) return null;
    value = BigInt(amount);
  } else if (typeof amount === "string") {
    if (amount.length > MAX_DIGITS || !/^\d+$/.test(amount)) return null;
    value = BigInt(amount);
  } else {
    return null;
  }
  if (value < 0n || value >= UINT256_EXCLUSIVE) return null;
  return value;
}
