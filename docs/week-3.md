# Week 3: configurable facilitator deadlines

Continue the original `x402-wrapper` repository. Version 0.2.0 exposed upstream
timeouts but left facilitator HTTP calls at the SDK's fixed 90-second default.
Slow verification/settlement can hold the bounded concurrency slots for too long.

## Implementation

- Add `FACILITATOR_TIMEOUT_MS` (default 90000, range 1–300000).
- Pass the deadline into the official SDK HTTPFacilitatorClient; use its real
  HTTP abort mechanism, not a Promise.race that leaves requests running.
- Validate environment and programmatic configuration; old Config objects retain
  the default through an optional field.
- Update CLI help, environment example and both READMEs with per-attempt semantics,
  custom-client boundaries, 429 initialization backoff and settlement uncertainty.

## Evidence

Seven new tests use real local HTTP with the SDK client, not a fake timeout error.
For each of supported/verify/settle they stall either response headers or the body.
They verify failure status, absence of protected output, no false payment receipt,
no automatic payment retry, expected upstream call count, health availability and
concurrency-slot recovery. Initialization can recover on the next unpaid request.
Config tests cover bounds and backwards compatibility.

Settlement timeout is not a no-charge guarantee. The upstream has run and a
facilitator may settle after the connection is aborted. Tests deliberately probe
recovery with unpaid requests rather than replaying a payment. No chain transaction
or published npm upgrade is claimed by these source tests.

## 可提交说明

第三周新增 FACILITATOR_TIMEOUT_MS 配置，接入官方 x402 SDK 的 HTTP 请求取消机制，
分别限制能力查询、付款验证和结算的响应等待时间，覆盖响应头与响应体。
保持默认 90 秒及旧配置兼容，新增参数校验、CLI 帮助和中英文说明。
新增真实本地 HTTP 故障测试，验证三个阶段的响应头/响应体停滞、付款前不调用上游、
结算超时不返回受保护内容、不自动重试付款，以及并发名额释放和健康检查可用性。
结算超时按结果未知处理，不宣称一定未扣款；测试不涉及真实链上付款。
