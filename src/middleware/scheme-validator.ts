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
  // 初始化后的路由策略独立于调用方配置；复用或修改原对象不能放宽准入条件。
  const acceptedSchemes = [...policy.acceptedSchemes];
  const minAmountUsd = policy.minAmountUsd;
  const facilitatorRequired = policy.facilitatorRequired;
  return async (c: Context, next: Next) => {
    const payment = await resolve?.(c);
    if (
      !payment ||
      !acceptedSchemes.includes(payment.scheme) ||
      !Number.isFinite(payment.amountUsd) ||
      payment.amountUsd < minAmountUsd ||
      (facilitatorRequired && !payment.facilitatorVerified)
    ) {
      return c.json({ error: "payment_policy_not_satisfied" }, 402, {
        "cache-control": "no-store",
      });
    }
    await next();
  };
};
