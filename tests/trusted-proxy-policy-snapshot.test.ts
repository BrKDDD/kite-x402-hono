import { expect, test } from "bun:test";
import { Hono } from "hono";
import { clientIpResolver } from "../src/client-ip.js";
import { testConfig } from "./helpers.js";
import type { Config } from "../src/config.js";
function fixture(config: Config) {
  const resolve = clientIpResolver(config);
  const app = new Hono();
  app.get("/", (c) => c.text(resolve(c) ?? "unknown"));
  return async (peer = "198.51.100.1", claim = "192.0.2.1") =>
    (
      await app.request(
        "http://local/",
        { headers: { "x-forwarded-for": claim } },
        { clientIp: peer },
      )
    ).text();
}
test("clearing the caller CIDR list cannot enable unrestricted header trust", async () => {
  const config = testConfig({
    TRUST_PROXY_HEADERS: "true",
    TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
  });
  const request = fixture(config);
  expect(await request()).toBe("198.51.100.1");
  config.trustedProxyCidrs!.length = 0;
  expect(await request()).toBe("198.51.100.1");
  expect(await request("10.0.0.1")).toBe("192.0.2.1");
});
test("changing the trust flag cannot enable an installed socket-only resolver", async () => {
  const config = testConfig();
  const request = fixture(config);
  config.trustProxyHeaders = true;
  expect(await request()).toBe("198.51.100.1");
});
test("changing the trust flag cannot disable an installed proxy policy", async () => {
  const config = testConfig({
    TRUST_PROXY_HEADERS: "true",
    TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
  });
  const request = fixture(config);
  config.trustProxyHeaders = false;
  expect(await request("10.0.0.1")).toBe("192.0.2.1");
});
test("legacy empty-list policy is stable if caller later appends rules", async () => {
  const config = testConfig({ TRUST_PROXY_HEADERS: "true" });
  const request = fixture(config);
  config.trustedProxyCidrs!.push("10.0.0.0/8");
  expect(await request()).toBe("192.0.2.1");
});
test("replacement config applies only to newly created independent resolvers", async () => {
  const config = testConfig({
    TRUST_PROXY_HEADERS: "true",
    TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
  });
  const old = fixture(config);
  config.trustedProxyCidrs = [];
  const fresh = fixture(config);
  expect(await old()).toBe("198.51.100.1");
  expect(await fresh()).toBe("192.0.2.1");
});
test("trusted-hop traversal and malformed forwarding chains retain their guards", async () => {
  const request = fixture(
    testConfig({
      TRUST_PROXY_HEADERS: "true",
      TRUSTED_PROXY_CIDRS: "10.0.0.0/8",
    }),
  );
  expect(await request("10.0.0.2", "192.0.2.1, 10.0.0.1")).toBe("192.0.2.1");
  expect(await request("10.0.0.2", "192.0.2.1, invalid")).toBe("10.0.0.2");
});
