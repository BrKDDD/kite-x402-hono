/**
 * Payment Lifecycle Webhook Dispatcher
 * Dispatches HMAC-SHA256 signed event notifications to merchant webhooks upon payment settlement.
 */

import { createHmac } from "crypto";

export interface WebhookEventPayload {
  id: string;
  eventType: "payment.verified" | "payment.settled" | "payment.failed";
  timestamp: number;
  data: Record<string, any>;
}

export interface WebhookEndpointConfig {
  url: string;
  secret: string;
  timeoutMs?: number;
}

export class WebhookDispatcher {
  public static signPayload(payload: string, secret: string): string {
    return createHmac("sha256", secret).update(payload).digest("hex");
  }

  public static async dispatch(
    endpoint: WebhookEndpointConfig,
    event: WebhookEventPayload,
    fetchFn = fetch,
  ): Promise<{ success: boolean; status?: number; error?: string }> {
    const serialized = JSON.stringify(event);
    const signature = this.signPayload(serialized, endpoint.secret);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      endpoint.timeoutMs ?? 5000,
    );

    try {
      const resp = await fetchFn(endpoint.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Kite-Signature": signature,
          "X-Kite-Event-Id": event.id,
          "X-Kite-Event-Type": event.eventType,
        },
        body: serialized,
        signal: controller.signal,
      });

      return {
        success: resp.ok,
        status: resp.status,
      };
    } catch (err: any) {
      return {
        success: false,
        error: err.message || "Failed to dispatch webhook",
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
