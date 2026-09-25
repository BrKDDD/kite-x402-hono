# Week 2: bounded concurrent payment requests

Direction: `x402-wrapper`. Continue in the original BrKDDD/kite-x402-hono repository.

## Problem and change

The first version admitted unlimited concurrent payment requests. Slow upstreams
or settlement could accumulate work even though individual bodies had size limits.
Add per-app admission control across the entire payment lifecycle, with a default
capacity of 64 and configurable `MAX_CONCURRENT_REQUESTS` (1–10000).

Overflow gets an explicit non-cacheable 503 `service_busy` plus Retry-After before
verification. No payment-bearing requests are queued. The slot survives settlement
and is released on both success and failure. Health checks remain available.
Older programmatic Config objects use the default when the new optional field is absent.

## Verification

`tests/concurrency.test.ts` exercises the official middleware with simulated payment
verification/settlement. Deterministic gates (not timing sleeps) hold requests during
upstream, initialization and settlement to test competing requests.

- Capacity 2: two admitted requests and 20 rejected requests; exactly two verify
  and upstream calls before release, then subsequent requests work.
- Capacity remains reserved until settlement finishes.
- Initialization is shared; independent app instances do not share capacity.
- Invalid payment, upstream errors, verification exceptions, settlement failure,
  settlement exceptions and initialization failure all release capacity.
- Config bounds and backwards-compatible programmatic defaults.

Run `npm run format:check`, `npm run check` and `npm run test:coverage`.
These are simulated payment tests, not real on-chain transactions.

## Submission summary

第二周在原仓库新增付费请求并发准入控制：通过 MAX_CONCURRENT_REQUESTS 限制完整的
初始化、付款验证、上游调用和结算生命周期。超额请求在验证付款前返回 503 service_busy，
附带 Retry-After，完成和异常路径均释放名额，健康检查不受影响。新增确定性的并发与故障
回归测试，验证突发请求、结算期间名额保留、初始化共享和失败恢复；同步更新中英文文档及配置示例。

This feature is included in release 0.2.0; npm 0.1.0 does not contain it.
No on-chain payment is claimed. This is a per-process resource bound, not payment
deduplication, exactly-once execution or a distributed rate limiter.
