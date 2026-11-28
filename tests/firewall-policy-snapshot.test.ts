import { describe, expect, test } from "bun:test";
import { createApp } from "../src/index.js";
import { createIpFirewall, evaluateIpFilter } from "../src/firewall.js";
import { harness, PAYER, PAY_TO, testConfig } from "./helpers.js";

function requestWithPeer(
  app: ReturnType<typeof createApp>,
  peerIp: string,
  path = "/v1/echo",
  headers?: Record<string, string>,
) {
  return app.request(path, headers ? { headers } : undefined, {
    clientIp: peerIp,
  });
}

async function signatureForPeer(
  app: ReturnType<typeof createApp>,
  peerIp: string,
  path = "/v1/echo",
): Promise<string> {
  const challengeRes = await requestWithPeer(app, peerIp, path);
  const encoded = challengeRes.headers.get("payment-required");
  if (challengeRes.status !== 402 || !encoded) {
    throw new Error(`Expected 402 challenge, got ${challengeRes.status}`);
  }
  const challenge = JSON.parse(Buffer.from(encoded, "base64").toString()) as {
    accepts: unknown[];
  };
  const payload = {
    x402Version: 2,
    accepted: challenge.accepts[0],
    payload: {
      signature: "0xfixture",
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: (challenge.accepts[0] as { amount: string }).amount,
        validAfter: "0",
        validBefore: "9999999999",
        nonce: `0x${"00".repeat(32)}`,
      },
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

describe("Firewall policy validation and snapshot isolation", () => {
  test("programmatic invalid allowlist or blocklist rules fail setup instead of failing open", () => {
    expect(() =>
      createApp({
        ...testConfig(),
        firewallBlocklist: ["198.51.100.0/99"],
      }),
    ).toThrow("Invalid firewall IP or CIDR");

    expect(() =>
      createApp({
        ...testConfig(),
        firewallAllowlist: ["192.0.2.1", "garbage"],
      }),
    ).toThrow("Invalid firewall IP or CIDR");

    expect(() =>
      createApp({
        ...testConfig(),
        firewallBlocklist: [""],
      }),
    ).toThrow("Invalid firewall IP or CIDR");

    expect(() =>
      evaluateIpFilter("198.51.100.5", { blocklist: ["198.51.100.0/99"] }),
    ).toThrow("Invalid firewall IP or CIDR");

    expect(() => evaluateIpFilter(null, { allowlist: ["::1/129"] })).toThrow(
      "Invalid firewall IP or CIDR",
    );

    expect(createIpFirewall({ allowlist: [], blocklist: [] })).toBeNull();
  });

  test("clearing or widening caller allowlist after createApp cannot disable whitelist mode", async () => {
    const config = testConfig({ FIREWALL_ALLOWLIST: "192.0.2.1" });
    const app = createApp(config);

    expect((await requestWithPeer(app, "192.0.2.1")).status).toBe(402);
    expect((await requestWithPeer(app, "203.0.113.9")).status).toBe(403);

    config.firewallAllowlist!.length = 0;
    expect((await requestWithPeer(app, "203.0.113.9")).status).toBe(403);
    expect((await requestWithPeer(app, "192.0.2.1")).status).toBe(402);

    config.firewallAllowlist!.push("0.0.0.0/0");
    expect((await requestWithPeer(app, "203.0.113.9")).status).toBe(403);
  });

  test("mutating caller blocklist after createApp cannot unblock denied peers or alter existing apps", async () => {
    const blockedConfig = testConfig({ FIREWALL_BLOCKLIST: "198.51.100.0/24" });
    const blockedApp = createApp(blockedConfig);

    expect((await requestWithPeer(blockedApp, "198.51.100.7")).status).toBe(
      403,
    );
    blockedConfig.firewallBlocklist!.length = 0;
    expect((await requestWithPeer(blockedApp, "198.51.100.7")).status).toBe(
      403,
    );

    const openConfig = testConfig();
    const openApp = createApp(openConfig);
    openConfig.firewallBlocklist = ["192.0.2.1"];

    expect((await requestWithPeer(openApp, "192.0.2.1")).status).toBe(402);
    const freshApp = createApp(openConfig);
    expect((await requestWithPeer(freshApp, "192.0.2.1")).status).toBe(403);
  });

  test("denied peer is rejected before verify/upstream/settle and allowed peer preserves payment lifecycle", async () => {
    const denied = harness({ env: { FIREWALL_ALLOWLIST: "192.0.2.1" } });
    const blockedRes = await requestWithPeer(denied.app, "203.0.113.5");
    expect(blockedRes.status).toBe(403);
    expect(blockedRes.headers.get("cache-control")).toBe("no-store");
    expect(await blockedRes.json()).toEqual({
      error: "forbidden_ip",
      reason: "not_in_allowlist",
      ip: "203.0.113.5",
    });
    expect(denied.events).toEqual([]);
    expect(
      (await requestWithPeer(denied.app, "203.0.113.5", "/healthz")).status,
    ).toBe(200);

    // 1. Missing/invalid payment
    const unpaid = harness({ env: { FIREWALL_ALLOWLIST: "192.0.2.1" } });
    expect((await requestWithPeer(unpaid.app, "192.0.2.1")).status).toBe(402);
    const invalidSigRes = await requestWithPeer(
      unpaid.app,
      "192.0.2.1",
      "/v1/echo",
      { "payment-signature": "not-base64-json" },
    );
    expect(invalidSigRes.status).toBe(402);
    expect(unpaid.events).toEqual([]);

    // 2. Valid payment -> verify -> upstream -> settle
    const ok = harness({ env: { FIREWALL_ALLOWLIST: "192.0.2.1" } });
    const sigOk = await signatureForPeer(ok.app, "192.0.2.1");
    const okRes = await requestWithPeer(ok.app, "192.0.2.1", "/v1/echo", {
      "payment-signature": sigOk,
    });
    expect(okRes.status).toBe(200);
    expect(okRes.headers.has("payment-response")).toBe(true);
    expect(ok.events).toEqual(["verify", "upstream", "settle"]);

    // 3. Upstream failure must not settle
    const upstreamFail = harness({
      env: { FIREWALL_ALLOWLIST: "192.0.2.1" },
      upstream: async () => new Response("upstream error", { status: 500 }),
    });
    const sigUpstreamFail = await signatureForPeer(
      upstreamFail.app,
      "192.0.2.1",
    );
    const failRes = await requestWithPeer(
      upstreamFail.app,
      "192.0.2.1",
      "/v1/echo",
      { "payment-signature": sigUpstreamFail },
    );
    expect(failRes.status).toBe(500);
    expect(upstreamFail.events).toEqual(["verify", "upstream"]);

    // 4. Settlement failure withholds protected data
    const settleFail = harness({
      env: { FIREWALL_ALLOWLIST: "192.0.2.1" },
      settles: false,
    });
    const sigSettleFail = await signatureForPeer(settleFail.app, "192.0.2.1");
    const settleFailRes = await requestWithPeer(
      settleFail.app,
      "192.0.2.1",
      "/v1/echo",
      { "payment-signature": sigSettleFail },
    );
    expect(settleFailRes.status).toBe(402);
    expect(settleFail.events).toEqual(["verify", "upstream", "settle"]);
  });
});
