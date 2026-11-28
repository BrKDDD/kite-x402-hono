import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app.js";
import { cleanHeaders } from "../src/proxy.js";
import { PAYER, signature, supported, testConfig } from "./helpers.js";

describe("case-insensitive custom upstream authentication filtering", () => {
  test.each(["x-api-key", "X-Api-Key", "X-API-KEY"])(
    "strips %s without altering source headers",
    (name) => {
      const original = new Headers({
        "X-Api-Key": "caller-fixture",
        "Accept-Language": "en",
      });
      const filtered = cleanHeaders(original, name);
      expect(filtered.has("x-api-key")).toBe(false);
      expect(filtered.get("accept-language")).toBe("en");
      expect(original.get("x-api-key")).toBe("caller-fixture");
    },
  );

  test("paid forwarding does not inherit caller credentials for a mixed-case configured name", async () => {
    const config = testConfig();
    config.authHeader = "X-Api-Key";
    config.authValue = "";
    let observed: Request | undefined;
    const app = createApp(config, {
      facilitator: {
        getSupported: async () => supported,
        verify: async () => ({ isValid: true, payer: PAYER }),
        settle: async () => ({
          success: true,
          transaction: "0xlocal-fixture",
          network: config.chain.network,
          payer: PAYER,
        }),
      },
      fetchUpstream: async (request) => {
        observed = request;
        return Response.json({ ok: true });
      },
    });
    const response = await app.request("/v1/echo", {
      headers: {
        "payment-signature": await signature(app),
        "X-Api-Key": "caller-fixture",
      },
    });
    expect(response.status).toBe(200);
    expect(observed?.headers.has("x-api-key")).toBe(false);
  });
});
