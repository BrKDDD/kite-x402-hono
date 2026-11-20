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
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // 通知准备失败也走结构化结果；通知失败不能作为重试链上付款的依据。
      const serialized = JSON.stringify(event);
      const signature = this.signPayload(serialized, endpoint.secret);
      timeout = setTimeout(
        () => controller.abort(),
        endpoint.timeoutMs ?? 5000,
      );
      const resp = await fetchFn(endpoint.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "Content-Type": "application/json",
          "X-Kite-Signature": signature,
          "X-Kite-Event-Id": event.id,
          "X-Kite-Event-Type": event.eventType,
        },
        body: serialized,
        signal: controller.signal,
      });

      void resp.body?.cancel().catch(() => {});
      return {
        success: resp.ok,
        status: resp.status,
      };
    } catch (err) {
      return {
        success: false,
        error:
          err instanceof Error && typeof err.message === "string" && err.message
            ? err.message
            : "Failed to dispatch webhook",
      };
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
