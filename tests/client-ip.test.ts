import { expect, test } from "bun:test";
import { createApp } from "../src/app.js";
import { harness, testConfig } from "./helpers.js";

test("direct clients use socket IP and cannot change buckets with forwarded headers", async () => {
  const { app } = harness({
    env: { RATE_LIMIT_RPS: "1", RATE_LIMIT_BURST: "1" },
  });
  const request = (peer: string, claim: string) =>
    app.request(
      "/v1/echo",
      {
        headers: { "x-forwarded-for": claim },
      },
      { clientIp: peer },
    );
  expect((await request("192.0.2.1", "10.0.0.1")).status).toBe(402);
  expect((await request("192.0.2.1", "10.0.0.2")).status).toBe(429);
  expect((await request("192.0.2.2", "10.0.0.1")).status).toBe(402);
});

test("socket identity is shared by firewall and access log", async () => {
  const lines: string[] = [];
  const { app } = harness({
    env: { FIREWALL_ALLOWLIST: "192.0.2.1", LOG_ENABLED: "true" },
    logSink: (line) => lines.push(line),
  });
  const response = await app.request(
    "/v1/echo",
    { headers: { "x-forwarded-for": "10.0.0.1" } },
    { clientIp: "192.0.2.1" },
  );
  expect(response.status).toBe(402);
  expect(JSON.parse(lines[0]!).clientIp).toBe("192.0.2.1");
});

test("trusted proxy chain is read from the socket towards the first untrusted hop", async () => {
  const { app } = harness({
    env: {
      TRUST_PROXY_HEADERS: "true",
      TRUSTED_PROXY_CIDRS: "127.0.0.1/32,10.0.0.0/8",
      FIREWALL_ALLOWLIST: "192.0.2.1",
    },
  });
  expect(
    (
      await app.request(
        "/v1/echo",
        { headers: { "x-forwarded-for": "198.51.100.1,192.0.2.1,10.0.0.2" } },
        { clientIp: "127.0.0.1" },
      )
    ).status,
  ).toBe(402);
  expect(
    (
      await app.request(
        "/v1/echo",
        { headers: { "x-forwarded-for": "192.0.2.1" } },
        { clientIp: "198.51.100.2" },
      )
    ).status,
  ).toBe(403);
  expect(
    (
      await app.request(
        "/v1/echo",
        { headers: { "x-forwarded-for": "garbage,192.0.2.1" } },
        { clientIp: "127.0.0.1" },
      )
    ).status,
  ).toBe(403);
});

test("explicit proxy mode falls back to socket when no forwarding header is present", async () => {
  const { app } = harness({
    env: { TRUST_PROXY_HEADERS: "true", FIREWALL_ALLOWLIST: "192.0.2.1" },
  });
  expect(
    (await app.request("/v1/echo", undefined, { clientIp: "192.0.2.1" }))
      .status,
  ).toBe(402);
  expect(() =>
    createApp(testConfig({ TRUSTED_PROXY_CIDRS: "127.0.0.1/nope" })),
  ).toThrow();
});
