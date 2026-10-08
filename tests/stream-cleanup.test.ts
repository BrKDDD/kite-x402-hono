import { expect, test } from "bun:test";
import { readLimited } from "../src/proxy.js";
import { harness, signature } from "./helpers.js";

for (const cleanup of ["pending", "reject"] as const) {
  for (const scenario of [
    "request-limit",
    "response-limit",
    "redirect",
  ] as const) {
    test(`${scenario}: ${cleanup} cleanup preserves error and releases capacity`, async () => {
      let cancelled = 0;
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new Uint8Array(5));
        },
        cancel() {
          cancelled++;
          return cleanup === "pending"
            ? pending
            : Promise.reject(new Error("cleanup failed"));
        },
      });
      const { app, events } = harness({
        env: { MAX_BODY_BYTES: "4", MAX_CONCURRENT_REQUESTS: "1" },
        upstream: async () =>
          new Response(stream, {
            status: scenario === "redirect" ? 302 : 200,
            headers:
              scenario === "redirect"
                ? { location: "https://elsewhere.example" }
                : {},
          }),
      });
      try {
        const response = await app.request("/v1/echo", {
          method: scenario === "request-limit" ? "POST" : "GET",
          ...(scenario === "request-limit" ? { body: stream } : {}),
          headers: { "payment-signature": await signature(app) },
        });
        expect(response.status).toBe(scenario === "request-limit" ? 413 : 502);
        expect(await response.json()).toEqual({
          error:
            scenario === "request-limit"
              ? "request_too_large"
              : scenario === "redirect"
                ? "upstream_redirect_refused"
                : "upstream_response_too_large",
        });
        expect(response.headers.get("payment-response")).toBeNull();
        expect(cancelled).toBe(1);
        expect(stream.locked).toBe(false);
        expect(events).toEqual(
          scenario === "request-limit" ? ["verify"] : ["verify", "upstream"],
        );
        expect((await app.request("/healthz")).status).toBe(200);
        expect((await app.request("/v1/echo")).status).toBe(402);
      } finally {
        finish();
      }
    }, 1000);
  }
}

test("already-aborted reads cancel and unlock their source", async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
    },
  });
  const controller = new AbortController();
  controller.abort();
  await expect(readLimited(stream, 4, controller.signal)).rejects.toThrow();
  expect(cancelled).toBe(1);
  expect(stream.locked).toBe(false);
});

test("aborting a pending read does not await producer cleanup", async () => {
  let cancelled = 0;
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const stream = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled++;
      return pending;
    },
  });
  const controller = new AbortController();
  const reading = readLimited(stream, 4, controller.signal);
  controller.abort();
  try {
    await expect(reading).rejects.toThrow();
    expect(cancelled).toBe(1);
    expect(stream.locked).toBe(false);
  } finally {
    finish();
  }
}, 1000);

test("successful reads preserve bytes without cancelling the producer", async () => {
  let cancelled = 0;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array([1, 2]));
      c.enqueue(new Uint8Array([3, 4]));
      c.close();
    },
    cancel() {
      cancelled++;
    },
  });
  expect(await readLimited(stream, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));
  expect(cancelled).toBe(0);
  expect(stream.locked).toBe(false);
});
