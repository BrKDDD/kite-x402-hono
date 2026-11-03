import type { Context, Next } from 'hono';

export interface RoutePaymentPolicy {
  acceptedSchemes: string[];
  minAmountUsd: number;
  facilitatorRequired?: boolean;
}

export const createSchemeValidator = (policy: RoutePaymentPolicy) => {
  return async (c: Context, next: Next) => {
    const schemeHeader = c.req.header('X-Payment-Scheme') || 'x402';
    if (!policy.acceptedSchemes.includes(schemeHeader)) {
      return c.json(
        {
          type: 'https://kite.ai/errors/unsupported-scheme',
          title: 'Unsupported Payment Scheme',
          status: 400,
          detail: `Scheme '${schemeHeader}' is not accepted on this endpoint.`,
        },
        400
      );
    }
    await next();
  };
};
