import { expect, test } from "bun:test";
import { Hono } from "hono";
import { structuredErrorLogger } from "../src/index.js";

function fixture(includeStack = false, sink?: (line: string) => void) {
  const logs: string[] = [];
  const app = new Hono();
  app.onError(
    structuredErrorLogger({
      includeStack,
      sink: sink ?? ((line) => logs.push(line)),
    }),
  );
  app.get("/fail", async () => {
    await Promise.resolve();
    throw Object.assign(new Error("secret-api-key"), {
      status: 200,
      code: "secret-code",
    });
  });
  app.get("/ok", (c) => c.text("ok"));
  return { app, logs };
}

test("Hono error handler emits JSON and conceals internal error fields", async () => {
  const { app, logs } = fixture();
  const response = await app.request("/fail", {
    headers: { "x-request-id": "client-123" },
  });
  expect(response.status).toBe(500);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("x-request-id")).toBe("client-123");
  expect(await response.json()).toEqual({
    error: "internal_error",
    requestId: "client-123",
  });
  expect(logs).toHaveLength(1);
  expect(JSON.parse(logs[0]!).requestId).toBe("client-123");
  expect(logs[0]).not.toContain("secret-api-key");
  expect((await app.request("/ok")).status).toBe(200);
  expect(logs).toHaveLength(1);
});

test("unsafe identifiers are replaced and stack traces remain server-side", async () => {
  const { app, logs } = fixture(true);
  const response = await app.request("/fail", {
    headers: { "x-request-id": "x".repeat(129), "x-trace-id": "untrusted" },
  });
  const body = await response.json();
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(response.headers.get("x-request-id")).toBe(body.requestId);
  expect(JSON.stringify(body)).not.toContain("secret");
  expect(JSON.parse(logs[0]!).stack).toContain("secret-api-key");
});

test("logging failures do not escape the error handler", async () => {
  const { app } = fixture(false, () => {
    throw new Error("sink failed");
  });
  expect((await app.request("/fail")).status).toBe(500);
});
