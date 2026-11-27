import { describe, expect, test } from "bun:test";
import type { PaymentRequired } from "@x402/core/types";
import { createApp, KITE_NETWORKS } from "../src/index.js";
import { harness, signature, testConfig } from "./helpers.js";

describe("installed app runtime configuration", () => {
  test("discovery and health retain the price and chain installed in the challenge", async () => {
    const { app, config } = harness();
    config.chain = { ...config.chain };
    const original = {
      price: config.price,
      chain: { ...config.chain },
      payTo: config.payTo,
    };
    config.price = "9";
    config.payTo = "0x1111111111111111111111111111111111111111";
    config.chain = KITE_NETWORKS.mainnet;
    const health = await (await app.request("/healthz")).json();
    const discovery = await (await app.request("/.well-known/x402")).json();
    const response = await app.request("/v1/echo");
    const challenge = JSON.parse(
      Buffer.from(
        response.headers.get("payment-required")!,
        "base64",
      ).toString(),
    ) as PaymentRequired;
    expect(response.status).toBe(402);
    expect(health).toMatchObject({
      network: original.chain.network,
      price: `$${original.price}`,
    });
    expect(discovery).toMatchObject({
      network: original.chain.network,
      pricing: { usd: `$${original.price}`, payTo: original.payTo },
    });
    expect(challenge.accepts[0]).toMatchObject({
      network: original.chain.network,
      payTo: original.payTo,
    });
  });

  test("nested chain metadata is owned by the app without freezing the caller", async () => {
    const config = testConfig();
    const mutableChain = { ...config.chain };
    config.chain = mutableChain;
    const app = createApp(config);
    mutableChain.symbol = "changed";
    mutableChain.decimals = 6;
    const discovery = await (await app.request("/.well-known/x402")).json();
    expect(discovery.asset).toMatchObject({ symbol: "pieUSD", decimals: 18 });
    expect(mutableChain.symbol).toBe("changed");
  });

  test("paid proxy uses the installed upstream and authentication after caller mutation", async () => {
    let observed: Request | undefined;
    const { app, config, events } = harness({
      env: { UPSTREAM_AUTH_VALUE: "local-fixture-auth" },
      upstream: async (request) => {
        observed = request;
        return Response.json({ ok: true });
      },
    });
    const payment = await signature(app);
    config.upstream = "https://changed.example";
    config.authValue = "changed";
    const response = await app.request("/v1/echo", {
      headers: { "payment-signature": payment },
    });
    expect(response.status).toBe(200);
    expect(events).toEqual(["verify", "upstream", "settle"]);
    expect(observed?.url).toBe("https://upstream.example/echo");
    expect(observed?.headers.get("authorization")).toBe("local-fixture-auth");
  });

  test("a second app can install revised values independently", async () => {
    const config = testConfig();
    const first = createApp(config);
    config.price = "0.02";
    const second = createApp(config);
    expect((await (await first.request("/healthz")).json()).price).toBe(
      "$0.001",
    );
    expect((await (await second.request("/healthz")).json()).price).toBe(
      "$0.02",
    );
  });
});
