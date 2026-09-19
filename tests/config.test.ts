import { describe, expect, test } from "bun:test";
import { KITE_NETWORKS, parsePrice, loadConfig } from "../src/index.js";
import { testConfig } from "./helpers.js";

describe("Kite configuration", () => {
  test("exact integer units and token domains for both networks", () => {
    expect(parsePrice("0.001", KITE_NETWORKS.mainnet)).toEqual({
      asset: KITE_NETWORKS.mainnet.asset,
      amount: "1000",
      extra: { name: "Bridged USDC (Kite AI)", version: "2" },
    });
    expect(parsePrice("$0.001", KITE_NETWORKS.testnet).amount).toBe(
      "1000000000000000",
    );
    expect(parsePrice("0.000001", KITE_NETWORKS.testnet).amount).toBe(
      "1000000000000",
    );
    expect(
      parsePrice("9007199254740993.123456", KITE_NETWORKS.mainnet).amount,
    ).toBe("9007199254740993123456");
  });
  test.each(["0", "-1", "1e-3", "NaN", "Infinity", "0.0000001", "1.", ".1"])(
    "rejects invalid price %s",
    (price) => {
      expect(() => parsePrice(price, KITE_NETWORKS.mainnet)).toThrow();
    },
  );
  test("validates mandatory config and network", () => {
    expect(() => loadConfig({})).toThrow("PAY_TO");
    expect(() => testConfig({ PAY_TO: `0x${"0".repeat(40)}` })).toThrow(
      "PAY_TO",
    );
    expect(() => testConfig({ KITE_NETWORK: "base" })).toThrow("KITE_NETWORK");
    expect(testConfig().facilitatorUrl).toBe(
      "https://facilitator.pieverse.io/v2",
    );
  });
  test.each([
    "https://user:password@example.com",
    "https://example.com/base",
    "https://example.com?key=secret",
    "file:///tmp/data",
    "http://remote.example",
  ])("rejects unsafe upstream %s", (url) => {
    expect(() => testConfig({ UPSTREAM_URL: url })).toThrow("UPSTREAM_URL");
  });
  test("permits local HTTP and preserves facilitator /v2", () => {
    expect(
      testConfig({ UPSTREAM_URL: "http://127.0.0.1:8081/" }).upstream,
    ).toBe("http://127.0.0.1:8081");
    expect(
      testConfig({ FACILITATOR_URL: "https://example.com/v2/" }).facilitatorUrl,
    ).toBe("https://example.com/v2");
  });
  test("rejects reserved auth headers and invalid limits", () => {
    for (const header of [
      "Host",
      "Connection",
      "PAYMENT-SIGNATURE",
      "x-payment",
      "bad header",
    ])
      expect(() => testConfig({ UPSTREAM_AUTH_HEADER: header })).toThrow();
    expect(() =>
      testConfig({ UPSTREAM_AUTH_VALUE: "secret\r\ninjected: x" }),
    ).toThrow();
    for (const [key, value] of [
      ["PORT", "65536"],
      ["PORT", "1.5"],
      ["UPSTREAM_TIMEOUT_MS", "0"],
      ["MAX_BODY_BYTES", "-1"],
    ]) {
      expect(() => testConfig({ [key!]: value! })).toThrow();
    }
  });
});
