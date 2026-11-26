import { expect, test } from "bun:test";
import { IdempotencyCache } from "../src/idempotency.js";
import { harness, signature } from "./helpers.js";

function streamed(value: string) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value));
      controller.close();
    },
  });
}

for (const declaredLength of [undefined, "3"]) {
  test(`fingerprint overflow is counted once with declared length ${declaredLength}`, async () => {
    const cache = new IdempotencyCache();
    const { app, events } = harness({
      env: { MAX_BODY_BYTES: "4" },
      idempotencyCache: cache,
      upstream: async () => new Response("ok"),
    });
    const headers = new Headers({
      "idempotency-key": "retryable",
      "payment-signature": await signature(app),
    });
    if (declaredLength) headers.set("content-length", declaredLength);
    for (let attempt = 1; attempt <= 2; attempt++) {
      const response = await app.request("/v1/echo", {
        method: "POST",
        headers,
        body: streamed("12345"),
      });
      expect(response.status).toBe(413);
      expect(await response.json()).toEqual({
        error: "idempotency_request_body_unavailable",
      });
      expect(events).toEqual([]);
      expect(cache.size()).toBe(0);
      const stats = await (await app.request("/stats")).json();
      expect(stats.traffic.too_large).toBe(attempt);
      expect(stats.capacity.active).toBe(0);
    }
    // 超限读取没有预占幂等键；同一付款凭据随后可用合法正文完成一次模拟结算。
    headers.delete("content-length");
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await app.request("/v1/echo", {
        method: "POST",
        headers,
        body: streamed("1234"),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
      expect(response.headers.get("idempotent-replayed")).toBe(
        attempt ? "true" : null,
      );
    }
    expect(events).toEqual(["verify", "upstream", "settle"]);
    const stats = await (await app.request("/stats")).json();
    expect(stats.traffic.too_large).toBe(2);
    expect(stats.capacity.active).toBe(0);
  });
}

test("exact-limit idempotent requests and replay do not count as oversized", async () => {
  const { app, events } = harness({
    env: { MAX_BODY_BYTES: "4" },
    upstream: async () => new Response("ok"),
  });
  const headers = {
    "idempotency-key": "exact",
    "payment-signature": await signature(app),
  };
  for (let i = 0; i < 2; i++) {
    const response = await app.request("/v1/echo", {
      method: "POST",
      headers,
      body: streamed("1234"),
    });
    expect(response.status).toBe(200);
    await response.text();
  }
  expect(events).toEqual(["verify", "upstream", "settle"]);
  expect((await (await app.request("/stats")).json()).traffic.too_large).toBe(
    0,
  );
});

for (const kind of ["abort", "timeout", "broken"] as const) {
  test(`fingerprint ${kind} does not masquerade as a size-limit rejection`, async () => {
    const cache = new IdempotencyCache();
    const { app, events } = harness({
      env: { UPSTREAM_TIMEOUT_MS: "30" },
      idempotencyCache: cache,
    });
    const headers = {
      "idempotency-key": "unavailable",
      "payment-signature": await signature(app),
    };
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        if (kind === "broken") c.error(new Error("fixture read failure"));
        else c.enqueue(new Uint8Array([1]));
      },
    });
    const timer =
      kind === "abort" ? setTimeout(() => controller.abort(), 5) : undefined;
    try {
      const response = await app.request("/v1/echo", {
        method: "POST",
        headers,
        body,
        signal: controller.signal,
      });
      expect(response.status).toBe(kind === "broken" ? 413 : 408);
      expect(events).toEqual([]);
      expect(cache.size()).toBe(0);
      const stats = await (await app.request("/stats")).json();
      expect(stats.traffic.too_large).toBe(0);
      expect(stats.capacity.active).toBe(0);
    } finally {
      clearTimeout(timer);
    }
  });
}

for (const kind of ["upstream-413", "upstream-body"] as const) {
  test(`${kind} does not increment local request-size metrics`, async () => {
    const { app, events } = harness({
      env: { MAX_BODY_BYTES: "4" },
      upstream: async () =>
        kind === "upstream-413"
          ? new Response(null, { status: 413 })
          : new Response("12345"),
    });
    const response = await app.request("/v1/echo", {
      method: "POST",
      body: streamed("1234"),
      headers: {
        "idempotency-key": kind,
        "payment-signature": await signature(app),
      },
    });
    expect(response.status).toBe(kind === "upstream-413" ? 413 : 502);
    expect(events).toEqual(["verify", "upstream"]);
    expect((await (await app.request("/stats")).json()).traffic.too_large).toBe(
      0,
    );
  });
}

test("declared oversize with idempotency is still counted only once", async () => {
  const { app, events } = harness({ env: { MAX_BODY_BYTES: "4" } });
  const response = await app.request("/v1/echo", {
    method: "POST",
    body: streamed("12345"),
    headers: {
      "content-length": "5",
      "idempotency-key": "declared",
      "payment-signature": await signature(app),
    },
  });
  expect(response.status).toBe(413);
  expect(await response.json()).toEqual({ error: "request_too_large" });
  expect(events).toEqual([]);
  expect((await (await app.request("/stats")).json()).traffic.too_large).toBe(
    1,
  );
});
