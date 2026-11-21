import { expect, test } from "bun:test";
import { Hono } from "hono";
import {
  createSchemeValidator,
  type RoutePaymentPolicy,
  type VerifiedPaymentMetadata,
} from "../src/middleware/scheme-validator.js";

const policy = (): RoutePaymentPolicy => ({
  acceptedSchemes: ["exact"],
  minAmountUsd: 1,
  facilitatorRequired: true,
});
const verified: VerifiedPaymentMetadata = {
  scheme: "exact",
  amountUsd: 2,
  facilitatorVerified: true,
};

function appFor(
  input: RoutePaymentPolicy,
  resolve: () => VerifiedPaymentMetadata | Promise<VerifiedPaymentMetadata>,
): Hono {
  const app = new Hono();
  app.use("*", createSchemeValidator(input, resolve));
  app.get("/", (c) => c.text("protected"));
  return app;
}

const cases: {
  name: string;
  mutate: (input: RoutePaymentPolicy) => void;
  payment: VerifiedPaymentMetadata;
}[] = [
  {
    name: "non-finite minimum",
    mutate: (input) => {
      input.minAmountUsd = NaN;
    },
    payment: { ...verified, amountUsd: 0.1 },
  },
  {
    name: "lower minimum",
    mutate: (input) => {
      input.minAmountUsd = 0;
    },
    payment: { ...verified, amountUsd: 0.1 },
  },
  {
    name: "expanded scheme array",
    mutate: (input) => {
      input.acceptedSchemes.push("upto");
    },
    payment: { ...verified, scheme: "upto" },
  },
  {
    name: "reassigned scheme array",
    mutate: (input) => {
      input.acceptedSchemes = ["upto"];
    },
    payment: { ...verified, scheme: "upto" },
  },
  {
    name: "disabled facilitator requirement",
    mutate: (input) => {
      input.facilitatorRequired = false;
    },
    payment: { ...verified, facilitatorVerified: false },
  },
];

for (const entry of cases) {
  test(`later ${entry.name} cannot weaken an installed payment policy`, async () => {
    const input = policy();
    const app = appFor(input, () => entry.payment);
    entry.mutate(input);
    const response = await app.request("/");
    expect(response.status).toBe(402);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      error: "payment_policy_not_satisfied",
    });
  });
}

test("source config remains caller-owned without changing an existing validator", async () => {
  const input = policy();
  const first = appFor(input, () => verified);
  // 配置可供调用方继续编辑，新策略必须显式创建新中间件，不能反向改变旧路由。
  input.acceptedSchemes.splice(0, 1, "upto");
  input.minAmountUsd = 10;
  const second = appFor(input, () => verified);
  expect((await first.request("/")).status).toBe(200);
  expect((await second.request("/")).status).toBe(402);
  expect(input.acceptedSchemes).toEqual(["upto"]);
  expect(input.minAmountUsd).toBe(10);
});

test("config changes during an async resolver cannot alter admission", async () => {
  const input = policy();
  let finish!: (payment: VerifiedPaymentMetadata) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = new Promise<VerifiedPaymentMetadata>((resolve) => {
    finish = resolve;
  });
  const app = appFor(input, () => {
    started();
    return pending;
  });
  const response = app.request("/");
  await entered;
  input.minAmountUsd = NaN;
  input.facilitatorRequired = false;
  finish({ ...verified, amountUsd: 0.1, facilitatorVerified: false });
  expect((await response).status).toBe(402);
});
