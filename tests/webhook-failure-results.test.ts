import { expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  WebhookDispatcher,
  type WebhookEventPayload,
} from "../src/webhook-dispatcher.js";

const endpoint = {
  url: "https://merchant.example/hook",
  secret: "synthetic-webhook-secret-for-tests",
  timeoutMs: 20,
};
const event: WebhookEventPayload = {
  id: "fixture-event",
  eventType: "payment.settled",
  timestamp: 1,
  data: { amount: "10" },
};

// Bun 的 fetch 还带 preconnect；保留该属性，使替身满足真实类型而无需强制转换。
function mockFetch(
  handler: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(handler, { preconnect: fetch.preconnect });
}

for (const kind of ["circular", "bigint"] as const) {
  test(`unserializable ${kind} event returns failure without delivery`, async () => {
    const data: Record<string, unknown> =
      kind === "bigint" ? { amount: 10n } : {};
    if (kind === "circular") data.self = data;
    let calls = 0;
    const fetchFn = mockFetch(async () => {
      calls++;
      return new Response();
    });
    const result = await WebhookDispatcher.dispatch(
      endpoint,
      { ...event, data },
      fetchFn,
    );
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(result.status).toBeUndefined();
    expect(calls).toBe(0);
  });
}

test("non-Error rejections become JSON-safe failures without retrying", async () => {
  for (const thrown of [null, undefined, "offline", 0]) {
    let calls = 0;
    const fetchFn = mockFetch(async () => {
      calls++;
      throw thrown;
    });
    const result = await WebhookDispatcher.dispatch(endpoint, event, fetchFn);
    expect(result.success).toBe(false);
    expect(typeof result.error).toBe("string");
    expect(JSON.parse(JSON.stringify(result)).success).toBe(false);
    expect(calls).toBe(1);
  }
});

test("ordinary Error messages remain available in the structured result", async () => {
  const fetchFn = mockFetch(async () => {
    throw new Error("fixture delivery failure");
  });
  expect(await WebhookDispatcher.dispatch(endpoint, event, fetchFn)).toEqual({
    success: false,
    error: "fixture delivery failure",
  });
});

test("HTTP status and signed payload stay unchanged", async () => {
  for (const status of [200, 503]) {
    let calls = 0;
    const fetchFn = mockFetch(async (_url: unknown, init?: RequestInit) => {
      calls++;
      expect(init?.redirect).toBe("error");
      expect(init?.body).toBe(JSON.stringify(event));
      const headers = new Headers(init?.headers);
      expect(headers.get("x-kite-signature")).toBe(
        createHmac("sha256", endpoint.secret)
          .update(JSON.stringify(event))
          .digest("hex"),
      );
      expect(headers.get("x-kite-event-id")).toBe(event.id);
      return new Response("fixture", { status });
    });
    expect(await WebhookDispatcher.dispatch(endpoint, event, fetchFn)).toEqual({
      success: status === 200,
      status,
    });
    expect(calls).toBe(1);
  }
});

test("completed and rejected delivery both clear the abort timer", async () => {
  const signals: AbortSignal[] = [];
  for (const fail of [false, true]) {
    const fetchFn = mockFetch(async (_url: unknown, init?: RequestInit) => {
      signals.push(init!.signal!);
      if (fail) throw null;
      return new Response();
    });
    await WebhookDispatcher.dispatch(endpoint, event, fetchFn);
  }
  // 失败通知不是重新付款的依据；这里只核对通知结束后不会残留定时中止。
  await Bun.sleep(40);
  expect(signals).toHaveLength(2);
  expect(signals.every((signal) => !signal.aborted)).toBe(true);
});

test("a delivery timeout remains a single structured failure", async () => {
  let calls = 0;
  const fetchFn = mockFetch(async (_url: unknown, init?: RequestInit) => {
    calls++;
    return new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener(
        "abort",
        () => reject(new Error("fixture timeout")),
        { once: true },
      );
    });
  });
  expect(await WebhookDispatcher.dispatch(endpoint, event, fetchFn)).toEqual({
    success: false,
    error: "fixture timeout",
  });
  expect(calls).toBe(1);
});
