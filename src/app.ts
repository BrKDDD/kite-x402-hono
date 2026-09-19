import { Hono } from "hono";
import {
  paymentMiddlewareFromHTTPServer,
  x402HTTPResourceServer,
  x402ResourceServer,
} from "@x402/hono";
import {
  HTTPFacilitatorClient,
  type FacilitatorClient,
} from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { loadConfig, type Config } from "./config.js";
import { parsePrice } from "./networks.js";
import { proxy, type FetchUpstream } from "./proxy.js";

export interface AppOptions {
  facilitator?: FacilitatorClient;
  fetchUpstream?: FetchUpstream;
}

export function createApp(
  config: Config = loadConfig(),
  options: AppOptions = {},
): Hono {
  const app = new Hono();
  const facilitator =
    options.facilitator ??
    new HTTPFacilitatorClient({ url: config.facilitatorUrl });
  const server = new x402ResourceServer(facilitator).register(
    config.chain.network,
    new ExactEvmScheme(),
  );
  const httpServer = new x402HTTPResourceServer(server, {
    "/v1/*": {
      accepts: {
        scheme: "exact",
        price: parsePrice(config.price, config.chain),
        network: config.chain.network,
        payTo: config.payTo,
        maxTimeoutSeconds: 60,
      },
      description: config.description,
      mimeType: "application/json",
    },
  });
  const payments = paymentMiddlewareFromHTTPServer(
    httpServer,
    undefined,
    undefined,
    false,
  );
  // Initialize lazily so /healthz never needs network access and startup errors stay request-scoped.
  let initialization: Promise<void> | undefined;
  app.get("/healthz", (c) =>
    c.json({
      ok: true,
      network: config.chain.network,
      asset: config.chain.symbol,
      price: `$${config.price}`,
    }),
  );
  app.use("/v1/*", async (c, next) => {
    c.header("cache-control", "no-store");
    try {
      initialization ??= httpServer.initialize().catch((error) => {
        initialization = undefined;
        throw error;
      });
      await initialization;
    } catch {
      return c.json({ error: "facilitator_unavailable" }, 503);
    }
    return payments(c, next);
  });
  app.all("/v1/*", (c) =>
    proxy(
      c.req.raw,
      config,
      options.fetchUpstream ?? ((request) => fetch(request)),
    ),
  );
  app.onError(() =>
    Response.json(
      { error: "internal_error" },
      { status: 500, headers: { "cache-control": "no-store" } },
    ),
  );
  return app;
}
