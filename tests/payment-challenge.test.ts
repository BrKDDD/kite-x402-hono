import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import {
  checkPaymentChallenge,
  formatPaymentChallenge,
  KITE_NETWORKS,
} from "../src/index.js";
import { harness, PAY_TO } from "./helpers.js";
const options = {
  url: "https://gateway.example/v1/echo",
  expectedNetwork: "testnet",
  expectedAmount: "1000000000000000",
  expectedPayTo: PAY_TO,
};
const entry = () => ({
  scheme: "exact",
  network: KITE_NETWORKS.testnet.network,
  asset: KITE_NETWORKS.testnet.asset,
  amount: options.expectedAmount,
  payTo: PAY_TO,
  maxTimeoutSeconds: 60,
});
const challenge = (body: unknown) =>
  new Response(null, {
    status: 402,
    headers: {
      "payment-required": Buffer.from(JSON.stringify(body)).toString("base64"),
    },
  });
const inspect = (accepts: unknown[], x402Version = 2) =>
  checkPaymentChallenge(options, async () =>
    challenge({ x402Version, accepts }),
  );

describe("unpaid payment challenge diagnostics", () => {
  test("checks the real SDK challenge without verify, upstream or settle", async () => {
    const { app, events } = harness();
    const report = await checkPaymentChallenge(options, async (url, init) => {
      expect(init.credentials).toBe("omit");
      expect(init.redirect).toBe("manual");
      expect(init.method).toBe("GET");
      expect(new Headers(init.headers).has("payment-signature")).toBe(false);
      return app.fetch(new Request(url, init));
    });
    expect(report.ok).toBe(true);
    expect(report.matchedIndex).toBe(0);
    expect(events).toEqual([]);
    expect(formatPaymentChallenge(report)).toContain(
      "No payment was signed or sent",
    );
  });
  test.each([
    ["scheme", "upto", "protocol_mismatch"],
    ["network", "eip155:2366", "network_mismatch"],
    ["asset", PAY_TO, "asset_mismatch"],
    ["amount", "1", "amount_mismatch"],
    [
      "payTo",
      "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      "recipient_mismatch",
    ],
    ["amount", "0", "invalid_challenge"],
    ["amount", (1n << 256n).toString(), "invalid_challenge"],
    ["amount", "01", "invalid_challenge"],
    ["payTo", "0x" + "0".repeat(40), "invalid_challenge"],
    ["maxTimeoutSeconds", 0, "invalid_challenge"],
  ] as const)("rejects invalid %s (%s)", async (field, value, code) => {
    expect(
      (await inspect([{ ...entry(), [field as string]: value }])).code,
    ).toBe(code);
  });
  test("accepts a matching alternative after malformed and mismatched alternatives", async () => {
    const r = await inspect([null, { ...entry(), amount: "2" }, entry()]);
    expect(r.ok).toBe(true);
    expect(r.matchedIndex).toBe(2);
    expect(r.alternatives).toHaveLength(3);
  });
  test("supports mainnet and case-insensitive EVM addresses", async () => {
    expect(
      (
        await checkPaymentChallenge(
          { ...options, expectedNetwork: "mainnet" },
          async () =>
            challenge({
              x402Version: 2,
              accepts: [
                {
                  ...entry(),
                  network: KITE_NETWORKS.mainnet.network,
                  asset: KITE_NETWORKS.mainnet.asset.toLowerCase(),
                },
              ],
            }),
        )
      ).ok,
    ).toBe(true);
  });
  test("rejects unsupported versions, empty or excessive alternatives", async () => {
    expect((await inspect([entry()], 1)).code).toBe("protocol_mismatch");
    for (const entries of [[], Array(101).fill(entry())])
      expect((await inspect(entries)).code).toBe("invalid_challenge");
  });
  test.each([
    "!!!!",
    "e30",
    "A".repeat(65540),
    Buffer.from([255]).toString("base64"),
    Buffer.from("not json").toString("base64"),
  ])("rejects invalid encoded header", async (header) => {
    expect(
      (
        await checkPaymentChallenge(
          options,
          async () =>
            new Response(null, {
              status: 402,
              headers: { "payment-required": header },
            }),
        )
      ).code,
    ).toBe("invalid_challenge");
  });
  test.each([
    [200, "not_payment_required"],
    [500, "not_payment_required"],
    [302, "redirect"],
    [402, "missing_header"],
  ] as const)("handles HTTP %s", async (status, code) => {
    expect(
      (
        await checkPaymentChallenge(
          options,
          async () => new Response(null, { status: status as number }),
        )
      ).code,
    ).toBe(code);
  });
  test("redacts remote data and network failures", async () => {
    const r = await checkPaymentChallenge(options, async () => {
      throw new Error("SECRET");
    });
    expect(r.code).toBe("unreachable");
    expect(JSON.stringify(r)).not.toContain("SECRET");
    expect(
      JSON.stringify(await inspect([{ ...entry(), amount: "SECRET" }])),
    ).not.toContain("SECRET");
  });
  test("enforces deadline", async () => {
    const r = await checkPaymentChallenge(
      { ...options, timeoutMs: 5 },
      async (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(new Error("aborted")),
            { once: true },
          );
        }),
    );
    expect(r.code).toBe("timeout");
  });
  test("does not consume or wait on an endless response body", async () => {
    let cancelled = false;
    const response = challenge({ x402Version: 2, accepts: [entry()] });
    const r = await checkPaymentChallenge(
      options,
      async () =>
        new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
              return new Promise(() => {});
            },
          }),
          { status: 402, headers: response.headers },
        ),
    );
    expect(r.ok).toBe(true);
    expect(cancelled).toBe(true);
  });
  test("validates local policy before any request", async () => {
    for (const change of [
      { url: "http://public.example/v1" },
      { url: "https://u:p@example.com" },
      { url: "not a url" },
      { expectedAmount: "0" },
      { expectedPayTo: "bad" },
      { expectedNetwork: "ethereum" },
      { timeoutMs: Infinity },
    ]) {
      await expect(
        checkPaymentChallenge({ ...options, ...change }, async () => {
          throw new Error("must not fetch");
        }),
      ).rejects.toThrow();
    }
  });
  test("CLI works against local HTTP without merchant environment", async () => {
    const { app, events } = harness();
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: app.fetch,
    });
    try {
      const proc = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          "--check-challenge",
          `${server.url}v1/echo`,
          "--network",
          "testnet",
          "--amount",
          options.expectedAmount,
          "--pay-to",
          PAY_TO,
          "--json",
        ],
        { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } },
      );
      const output = await new Response(proc.stdout).text();
      expect(await proc.exited).toBe(0);
      expect(JSON.parse(output).ok).toBe(true);
      expect(events).toEqual([]);
    } finally {
      await server.stop(true);
    }
  });
  test("CLI rejects missing policy and conflicting modes", async () => {
    for (const args of [
      ["--check-challenge"],
      ["--check-challenge", options.url, "--check-config"],
    ]) {
      const proc = Bun.spawn(
        [
          process.execPath,
          fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
          ...args,
          "--json",
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const result = JSON.parse(await new Response(proc.stdout).text());
      expect(await proc.exited).toBe(1);
      expect(result.ok).toBe(false);
    }
  });
});
