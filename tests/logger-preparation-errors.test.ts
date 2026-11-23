import { expect, test } from "bun:test";
import { Hono } from "hono";
import { createAccessLogger } from "../src/logger.js";
import { harness, signature } from "./helpers.js";

for (const status of [200, 402, 502] as const)
  test(`diagnostic resolver failures preserve HTTP ${status}`, async () => {
    const logs: string[] = [];
    const app = new Hono();
    app.onError((_e, c) => c.text("unexpected logging failure", 500));
    app.use(
      "*",
      createAccessLogger(
        {},
        (line) => logs.push(line),
        () => {
          throw Error("fixture resolver failure");
        },
      ),
    );
    app.get("/", (c) =>
      c.text("original", status, { "x-fixture": "retained" }),
    );
    const r = await app.request("/");
    expect(r.status).toBe(status);
    expect(await r.text()).toBe("original");
    expect(r.headers.get("x-fixture")).toBe("retained");
    expect(logs).toEqual([]);
  });
test("throwing log sinks still preserve completed responses", async () => {
  const app = new Hono();
  app.use(
    "*",
    createAccessLogger(
      {},
      () => {
        throw Error("fixture sink failure");
      },
      () => null,
    ),
  );
  app.get("/", (c) => c.text("ok"));
  const r = await app.request("/");
  expect(r.status).toBe(200);
  expect(await r.text()).toBe("ok");
});
test("disabled and health-skipped loggers do not resolve diagnostic identity", async () => {
  for (const enabled of [true, false]) {
    let calls = 0;
    const app = new Hono();
    app.use(
      "*",
      createAccessLogger(
        { enabled },
        () => {},
        () => {
          calls++;
          throw Error("unused");
        },
      ),
    );
    app.get("/*", (c) => c.text("ok"));
    const r = await app.request(enabled ? "/healthz" : "/other");
    expect(r.status).toBe(200);
    expect(calls).toBe(0);
  }
});
test("application errors still reach Hono error handling and retain their status", async () => {
  const app = new Hono();
  let handled = 0;
  const logs: string[] = [];
  app.onError((_error, c) => {
    handled++;
    return c.text("handled", 418);
  });
  app.use(
    "*",
    createAccessLogger(
      {},
      (line) => logs.push(line),
      () => null,
    ),
  );
  app.get("/", () => {
    throw Error("application failure");
  });
  const r = await app.request("/");
  expect(r.status).toBe(418);
  expect(await r.text()).toBe("handled");
  expect(handled).toBe(1);
  expect(JSON.parse(logs[0]!).status).toBe(418);
});
for (const kind of ["success", "invalid", "upstream", "settlement"] as const)
  test(`logging failure preserves mocked paid ${kind} outcome`, async () => {
    const { app: paid, events } = harness({
      valid: kind !== "invalid",
      settles: kind !== "settlement",
      upstream: async () =>
        new Response("protected", { status: kind === "upstream" ? 502 : 200 }),
    });
    const token = await signature(paid);
    const app = new Hono();
    // 外层只负责诊断，不参与身份授权；不得将日志故障转成再次付款的理由。
    app.use(
      "*",
      createAccessLogger(
        {},
        () => {},
        () => {
          throw Error("fixture diagnostics failure");
        },
      ),
    );
    app.all("/*", (c) => paid.request(c.req.raw));
    const r = await app.request("/v1/echo", {
      headers: { "payment-signature": token },
    });
    expect(r.status).toBe(
      kind === "success" ? 200 : kind === "upstream" ? 502 : 402,
    );
    expect(events).toEqual(
      kind === "invalid"
        ? ["verify"]
        : kind === "upstream"
          ? ["verify", "upstream"]
          : ["verify", "upstream", "settle"],
    );
    if (kind === "success") expect(await r.text()).toBe("protected");
  });
