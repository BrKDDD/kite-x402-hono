import { expect, test } from "bun:test";
import { probeService } from "../src/index.js";
import { harness } from "./helpers.js";

const options = {
  origin: "https://gateway.example",
  expectedNetwork: "testnet",
};

/** Wrap a real gateway response so only the service-probe cleanup path is hostile. */
async function hostileResponse(url: string, cancel: () => unknown) {
  const { app } = harness();
  const response = await app.request(new URL(url).pathname);
  const reader = response.body!.getReader();
  return {
    status: response.status,
    headers: response.headers,
    body: {
      getReader: () => reader,
      cancel,
    },
  } as unknown as Response;
}

test("a throwing body cancel cannot replace a successful probe report", async () => {
  const report = await probeService(options, (url) =>
    hostileResponse(url, () => {
      throw new Error("cleanup boom");
    }),
  );
  expect(report.ok).toBe(true);
  expect(report.checks.map((c) => c.code)).toEqual(["ok", "ok", "ok"]);
  expect(JSON.stringify(report)).not.toContain("cleanup boom");
});

test("a non-promise body cancel cannot reject the whole probe", async () => {
  const report = await probeService(options, (url) =>
    hostileResponse(url, () => undefined),
  );
  expect(report.ok).toBe(true);
  expect(report.checks).toHaveLength(3);
});

test("a rejecting body cancel stays a best-effort cleanup", async () => {
  const report = await probeService(options, (url) =>
    hostileResponse(url, () => Promise.reject(new Error("cleanup boom"))),
  );
  expect(report.ok).toBe(true);
  expect(JSON.stringify(report)).not.toContain("cleanup boom");
});

test("a throwing body getter cannot reject the whole probe", async () => {
  let reads = 0;
  const report = await probeService(options, async (url) => {
    const { app } = harness();
    const response = await app.request(new URL(url).pathname);
    return Object.defineProperty(response, "body", {
      get() {
        reads++;
        throw new Error("body getter boom");
      },
    });
  });
  expect(report.ok).toBe(false);
  expect(report.checks.every((c) => c.code === "invalid_response")).toBe(true);
  expect(reads).toBeGreaterThanOrEqual(3);
  expect(JSON.stringify(report)).not.toContain("body getter boom");
});

test("cleanup failure preserves the diagnostic produced by a failed read", async () => {
  const report = await probeService(options, async (url) => {
    const response = await hostileResponse(url, () => {
      throw new Error("cleanup boom");
    });
    Object.defineProperty(response.body!, "getReader", {
      value: () => {
        throw new Error("read failure");
      },
    });
    return response;
  });
  expect(report.ok).toBe(false);
  expect(report.checks.every((c) => c.code === "invalid_response")).toBe(true);
  expect(JSON.stringify(report)).not.toContain("cleanup boom");
});
