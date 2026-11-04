import { describe, it, expect } from "bun:test";
import {
  WebhookDispatcher,
  type WebhookEventPayload,
} from "../src/webhook-dispatcher.js";

describe("WebhookDispatcher", () => {
  it("generates deterministic HMAC-SHA256 signatures", () => {
    const sig1 = WebhookDispatcher.signPayload("test_content", "secret_key");
    const sig2 = WebhookDispatcher.signPayload("test_content", "secret_key");
    expect(sig1).toBe(sig2);
    expect(sig1.length).toBe(64);
  });

  it("dispatches webhook with required headers", async () => {
    let capturedHeaders: HeadersInit | undefined;
    let capturedBody: string | undefined;

    const mockFetch = (async (url: string, init?: RequestInit) => {
      capturedHeaders = init?.headers;
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({ received: true }), { status: 200 });
    }) as typeof fetch;

    const event: WebhookEventPayload = {
      id: "evt-001",
      eventType: "payment.settled",
      timestamp: Date.now(),
      data: { txHash: "0x123", amount: "10.0" },
    };

    const res = await WebhookDispatcher.dispatch(
      { url: "https://example.com/webhook", secret: "secret_123" },
      event,
      mockFetch,
    );

    expect(res.success).toBe(true);
    expect(res.status).toBe(200);
    expect(capturedHeaders).toBeDefined();
  });
});
