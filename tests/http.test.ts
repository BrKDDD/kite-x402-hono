import { expect, test } from "bun:test";
import type { PaymentRequired } from "@x402/core/types";
import { createApp } from "../src/index.js";
import { PAY_TO, PAYER, supported, testConfig } from "./helpers.js";

test("HTTP round trip uses SDK supported/verify/settle endpoints and proxies POST bytes", async () => {
  const events: string[] = [];
  const facilitator = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === "/v2/supported") return Response.json(supported);
      const body = (await request.json()) as {
        paymentRequirements: { payTo: string; network: string; amount: string };
      };
      expect(body.paymentRequirements).toMatchObject({
        payTo: PAY_TO,
        network: "eip155:2368",
        amount: "1000000000000000",
      });
      if (path === "/v2/verify") {
        events.push("verify");
        return Response.json({ isValid: true, payer: PAYER });
      }
      if (path === "/v2/settle") {
        events.push("settle");
        return Response.json({
          success: true,
          transaction: "0xsimulated-http-receipt",
          network: "eip155:2368",
          payer: PAYER,
        });
      }
      return new Response(null, { status: 404 });
    },
  });
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      events.push("upstream");
      expect(request.headers.get("payment-signature")).toBeNull();
      expect(request.headers.get("authorization")).toBe("Bearer server-key");
      return Response.json({
        path: new URL(request.url).pathname,
        query: new URL(request.url).search,
        body: await request.text(),
      });
    },
  });
  const app = createApp(
    testConfig({
      UPSTREAM_URL: upstream.url.origin,
      FACILITATOR_URL: `${facilitator.url.origin}/v2`,
      UPSTREAM_AUTH_VALUE: "Bearer server-key",
    }),
  );
  const wrapper = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: app.fetch,
  });
  try {
    const url = `${wrapper.url.origin}/v1/echo?value=42`;
    const unpaid = await fetch(url, { method: "POST", body: "hello" });
    expect(unpaid.status).toBe(402);
    const challenge = JSON.parse(
      Buffer.from(unpaid.headers.get("payment-required")!, "base64").toString(),
    ) as PaymentRequired;
    await unpaid.arrayBuffer();
    const payment = Buffer.from(
      JSON.stringify({
        x402Version: 2,
        accepted: challenge.accepts[0],
        payload: { signature: "0xsimulated" },
      }),
    ).toString("base64");
    const paid = await fetch(url, {
      method: "POST",
      body: "hello",
      headers: { "payment-signature": payment },
    });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({
      path: "/echo",
      query: "?value=42",
      body: "hello",
    });
    expect(events).toEqual(["verify", "upstream", "settle"]);
    expect(paid.headers.has("payment-response")).toBe(true);
  } finally {
    await wrapper.stop(true);
    await upstream.stop(true);
    await facilitator.stop(true);
  }
});

test("real fetch timeout covers a stalled response body and skips settlement", async () => {
  let settles = 0;
  const upstream = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("partial"));
          },
        }),
      );
    },
  });
  const app = createApp(
    testConfig({
      UPSTREAM_URL: upstream.url.origin,
      UPSTREAM_TIMEOUT_MS: "30",
    }),
    {
      facilitator: {
        getSupported: async () => supported,
        verify: async () => ({ isValid: true, payer: PAYER }),
        settle: async () => {
          settles++;
          return { success: true, transaction: "mock", network: "eip155:2368" };
        },
      },
    },
  );
  try {
    const { signature } = await import("./helpers.js");
    const result = await app.request("/v1/echo", {
      headers: { "payment-signature": await signature(app) },
    });
    expect(result.status).toBe(504);
    expect(settles).toBe(0);
  } finally {
    await upstream.stop(true);
  }
});
