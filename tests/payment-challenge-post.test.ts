import { expect, test } from "bun:test";
import {
  checkPaymentChallenge,
  formatPaymentChallenge,
  type PaymentChallengeOptions,
} from "../src/index.js";
import { harness, PAY_TO } from "./helpers.js";
const policy = {
  url: "https://gateway.example/v1/echo",
  expectedNetwork: "testnet",
  expectedAmount: "1000000000000000",
  expectedPayTo: PAY_TO,
};
test("POST-only local endpoint receives exact JSON without credentials or payment", async () => {
  const { app, events } = harness();
  let calls = 0;
  const body = '{"prompt":"私密 SECRET"}';
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      calls++;
      if (req.method !== "POST") return new Response(null, { status: 405 });
      expect(req.headers.get("content-type")).toBe("application/json");
      expect(req.headers.has("authorization")).toBe(false);
      expect(req.headers.has("payment-signature")).toBe(false);
      expect(await req.clone().text()).toBe(body);
      return app.fetch(req);
    },
  });
  try {
    const options = {
      ...policy,
      url: `${server.url}v1/echo`,
      method: "POST" as const,
      jsonBody: body,
    };
    const result = await checkPaymentChallenge(options);
    expect(result.ok).toBe(true);
    const mismatch = await checkPaymentChallenge({
      ...options,
      expectedAmount: "1",
    });
    expect(mismatch.code).toBe("amount_mismatch");
    expect(
      JSON.stringify(result) + formatPaymentChallenge(result),
    ).not.toContain("SECRET");
    expect(calls).toBe(2);
    expect(events).toEqual([]);
  } finally {
    await server.stop(true);
  }
});
test("invalid request configuration fails before fetch with fixed errors", async () => {
  let calls = 0;
  for (const change of [
    { jsonBody: "{}" },
    { method: "PUT" },
    { method: null },
    { method: "POST", jsonBody: {} },
    { method: "POST", jsonBody: "SECRET invalid" },
    { method: "POST", jsonBody: '"' + "x".repeat(16383) + '"' },
    { method: "POST", jsonBody: '"' + "中".repeat(6000) + '"' },
  ]) {
    let message = "";
    try {
      await checkPaymentChallenge(
        { ...policy, ...change } as PaymentChallengeOptions,
        async () => {
          calls++;
          return new Response();
        },
      );
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message.length).toBeGreaterThan(0);
    expect(message).not.toContain("SECRET");
  }
  expect(calls).toBe(0);
});
test("exact UTF-8 limit and arbitrary valid JSON values are accepted", async () => {
  for (const body of [
    '"' + "x".repeat(16382) + '"',
    '"' + "中".repeat(5460) + 'xx"',
    "null",
    "false",
    "0",
    "[]",
  ]) {
    const r = await checkPaymentChallenge(
      { ...policy, method: "POST", jsonBody: body },
      async (_url, init) => {
        expect(init.body).toBe(body);
        expect(init.method).toBe("POST");
        expect(init.redirect).toBe("manual");
        expect(init.credentials).toBe("omit");
        return new Response(null, { status: 402 });
      },
    );
    expect(r.code).toBe("missing_header");
  }
});
test("bodyless POST and default GET retain no content-type or body", async () => {
  for (const method of [undefined, "POST"] as const)
    await checkPaymentChallenge(
      { ...policy, ...(method ? { method } : {}) },
      async (_url, init) => {
        expect(init.method).toBe(method ?? "GET");
        expect(init.body).toBeUndefined();
        expect(new Headers(init.headers).has("content-type")).toBe(false);
        return new Response();
      },
    );
});
test("POST redirect is not retried and pre-cancelled POST sends nothing", async () => {
  let calls = 0;
  const fetcher = async () => {
    calls++;
    return new Response(null, { status: 307 });
  };
  expect(
    (
      await checkPaymentChallenge(
        { ...policy, method: "POST", jsonBody: "{}" },
        fetcher,
      )
    ).code,
  ).toBe("redirect");
  const c = new AbortController();
  c.abort();
  expect(
    (
      await checkPaymentChallenge(
        { ...policy, method: "POST", jsonBody: "{}", signal: c.signal },
        fetcher,
      )
    ).code,
  ).toBe("cancelled");
  expect(calls).toBe(1);
});
