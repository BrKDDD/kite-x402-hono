import type { Context, Next } from "hono";
export interface RoutePaymentPolicy {
  acceptedSchemes: string[];
  minAmountUsd: number;
  facilitatorRequired?: boolean;
}
export interface VerifiedPaymentMetadata {
  scheme: string;
  amountUsd: number;
  facilitatorVerified: boolean;
}
/** Place after verification; metadata must come from trusted server code. */
export const createSchemeValidator = (
  policy: RoutePaymentPolicy,
  resolve?: (
    c: Context,
  ) =>
    | VerifiedPaymentMetadata
    | undefined
    | Promise<VerifiedPaymentMetadata | undefined>,
) => {
  if (
    !policy.acceptedSchemes.length ||
    !Number.isFinite(policy.minAmountUsd) ||
    policy.minAmountUsd < 0
  )
    throw new Error("Invalid payment policy");
  return async (c: Context, next: Next) => {
    const payment = await resolve?.(c);
    if (
      !payment ||
      !policy.acceptedSchemes.includes(payment.scheme) ||
      !Number.isFinite(payment.amountUsd) ||
      payment.amountUsd < policy.minAmountUsd ||
      (policy.facilitatorRequired && !payment.facilitatorVerified)
    ) {
      return c.json({ error: "payment_policy_not_satisfied" }, 402, {
        "cache-control": "no-store",
      });
    }
    await next();
  };
};
