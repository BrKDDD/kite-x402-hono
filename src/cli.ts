#!/usr/bin/env bun
const args = process.argv.slice(2);
const switches = new Set(["--help", "--check-config", "--json"]);
const valueOptions = new Set([
  "--probe-service",
  "--check-challenge",
  "--network",
  "--amount",
  "--pay-to",
]);
let unsupportedArgument = false;
for (let index = 0; index < args.length; index++) {
  const argument = args[index]!;
  if (switches.has(argument)) continue;
  if (valueOptions.has(argument)) {
    // 缺值仍交给原模式诊断；正常选项值不能被误认为独立的位置参数。
    if (args[index + 1] !== undefined && !args[index + 1]!.startsWith("--"))
      index++;
    continue;
  }
  unsupportedArgument = true;
  break;
}

if (unsupportedArgument) {
  // 先拒绝拼错的离线命令，避免意外启动付费网关或发起诊断请求；不回显参数内容。
  const error = "Unsupported CLI argument. Use --help for supported options.";
  if (args.includes("--json"))
    console.log(JSON.stringify({ ok: false, error }));
  else console.error(error);
  process.exitCode = 1;
} else if (process.argv.includes("--help")) {
  console.log(
    "Usage: kite-x402-hono [--check-config [--json]]\n--check-config: validate configuration offline without starting the server\n--probe-service ORIGIN --network NETWORK: check public gateway diagnostics\n--check-challenge URL --network NETWORK --amount ATOMIC --pay-to ADDRESS: inspect an unpaid 402 challenge\n--json: machine-readable diagnostic report\nRequired: PAY_TO, UPSTREAM_URL\nOptional: KITE_NETWORK, PRICE_USD, PORT, FACILITATOR_URL, UPSTREAM_AUTH_HEADER, UPSTREAM_AUTH_VALUE, UPSTREAM_TIMEOUT_MS, MAX_BODY_BYTES, MAX_CONCURRENT_REQUESTS, FACILITATOR_TIMEOUT_MS, CORS_ORIGIN, SHUTDOWN_TIMEOUT_MS\nSee README.md for configuration and examples.",
  );
} else if (process.argv.includes("--check-challenge")) {
  try {
    const args = process.argv.slice(2);
    if (args.includes("--check-config") || args.includes("--probe-service"))
      throw new Error("Choose one diagnostic mode.");
    const value = (flag: string) => {
      const at = args.indexOf(flag);
      return at >= 0 ? args[at + 1] : undefined;
    };
    const url = value("--check-challenge");
    const expectedNetwork = value("--network");
    const expectedAmount = value("--amount");
    const expectedPayTo = value("--pay-to");
    if (!url || !expectedNetwork || !expectedAmount || !expectedPayTo)
      throw new Error(
        "Supply --check-challenge URL --network NETWORK --amount ATOMIC --pay-to ADDRESS.",
      );
    const { checkPaymentChallenge, formatPaymentChallenge } = await import(
      "./payment-challenge.js"
    );
    const report = await checkPaymentChallenge({
      url,
      expectedNetwork,
      expectedAmount,
      expectedPayTo,
    });
    console.log(
      args.includes("--json")
        ? JSON.stringify(report)
        : formatPaymentChallenge(report),
    );
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Challenge check failed.";
    if (process.argv.includes("--json"))
      console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exitCode = 1;
  }
} else if (process.argv.includes("--probe-service")) {
  try {
    if (process.argv.includes("--check-config"))
      throw new Error("Choose either --probe-service or --check-config.");
    const args = process.argv.slice(2);
    const value = (flag: string) => {
      const at = args.indexOf(flag);
      return at >= 0 ? args[at + 1] : undefined;
    };
    const origin = value("--probe-service");
    const expectedNetwork = value("--network");
    if (!origin || !expectedNetwork)
      throw new Error(
        "Supply --probe-service ORIGIN and --network mainnet|testnet.",
      );
    const { probeService, formatServiceProbe } = await import(
      "./service-probe.js"
    );
    const report = await probeService({ origin, expectedNetwork });
    console.log(
      args.includes("--json")
        ? JSON.stringify(report)
        : formatServiceProbe(report),
    );
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Service probe failed.";
    if (process.argv.includes("--json"))
      console.log(JSON.stringify({ ok: false, error: message }));
    else console.error(message);
    process.exitCode = 1;
  }
} else if (process.argv.includes("--check-config")) {
  // 离线诊断只加载配置校验，避免初始化服务器依赖。
  const { checkConfig, formatConfigPreflight } = await import(
    "./config-preflight.js"
  );
  const report = checkConfig();
  console.log(
    process.argv.includes("--json")
      ? JSON.stringify(report)
      : formatConfigPreflight(report),
  );
  process.exitCode = report.ok ? 0 : 1;
} else if (process.argv.includes("--json")) {
  console.error(
    "--json requires --check-config, --probe-service or --check-challenge",
  );
  process.exitCode = 1;
} else {
  try {
    const { loadConfig } = await import("./config.js");
    const config = loadConfig();
    const { createApp } = await import("./app.js");
    const app = createApp(config);
    const server = Bun.serve({
      port: config.port,
      fetch: (request, server) =>
        app.fetch(request, {
          clientIp: server.requestIP(request)?.address ?? null,
        }),
      maxRequestBodySize: config.maxBodyBytes,
      idleTimeout: 0,
    });
    console.log(
      `Kite x402 Hono listening at ${server.url} (${config.chain.network})`,
    );
    let isShuttingDown = false;
    const shutdown = (signal: string) => {
      if (isShuttingDown) return;
      isShuttingDown = true;
      console.log(`Received ${signal}, initiating graceful shutdown...`);
      const stopped = server.stop(false);
      const timeoutMs = config.shutdownTimeoutMs ?? 10000;
      const timer = setTimeout(() => {
        console.warn(
          "Graceful shutdown timeout exceeded, forcing connection close.",
        );
        void server.stop(true);
        process.exit(0);
      }, timeoutMs);
      timer.unref?.();
      void stopped.finally(() => clearTimeout(timer));
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Unable to start wrapper",
    );
    process.exitCode = 1;
  }
}
