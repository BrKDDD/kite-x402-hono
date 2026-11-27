# Diagnostics and acceptance handoff / 诊断与验收交接

## Reproduce from source / 从源码复现

Use Node 22 and Bun 1.4.2, the versions exercised by CI. Start in this repository:
使用 CI 验证的 Node 22 和 Bun 1.4.2，在仓库目录运行：

```sh
npm ci
npm run check
npm run test:coverage
npm run format:check
npm audit --omit=dev --audit-level=high
bun dist/acceptance-report.js --json > acceptance-summary.json
bun dist/acceptance-report.js > acceptance-summary.md
```

Both summary commands run fresh simulations. Check each exit code; a saved file
alone does not imply success. The summary must have `ok: true` and 18 passing
checks. Preserve the exact source commit (`git rev-parse HEAD`) separately.
两次摘要命令各自重新验收；文件存在不代表成功，需检查退出码、ok 和 18 项检查，并另存源码提交 SHA。

## What each command establishes / 每条命令证明什么

| Command                                                                           | Evidence / 证据                                                      | Boundary / 边界                                                            |
| --------------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `bun dist/cli.js --check-config --json`                                           | Validates supplied merchant configuration offline / 离线校验商户配置 | Does not contact services / 不验证连通性                                   |
| `--probe-service ORIGIN --network testnet --json`                                 | Reads health/readiness/discovery / 读取诊断端点                      | Operator-controlled target; no payment / 仅操作者目标，不付款              |
| `--check-challenge URL --network testnet --amount ATOMIC --pay-to ADDRESS --json` | Compares an unpaid GET offer to independent policy / 核对未付款报价  | Atomic amount, not decimal price; no signature / 整数最小单位，不签名      |
| `bun dist/local-acceptance.js --json`                                             | Ten local diagnostic assertions / 十项本地诊断断言                   | Fixed synthetic config; zero payment operations / 固定模拟配置，零支付调用 |
| `bun dist/delivery-acceptance.js --json`                                          | Five delivery cases and three retries / 五项交付及三项重试           | Fake signature and settlement stub / 模拟签名与结算                        |
| `bun dist/acceptance-report.js`                                                   | Sanitized Markdown summary / 脱敏摘要                                | Assertions, not signed execution proof / 不是签名执行证明                  |

The second and third rows are options to `bun dist/cli.js`. Replace placeholders
with independently confirmed operator values; do not infer policy from untrusted offers.
第二、三行是 CLI 参数；占位值必须独立确认，不从不可信报价抄取预期策略。

## Retry and failure limits / 重试与失败边界

The delivery runner explicitly installs an in-memory nonce guard. Cached success
replays must not re-deliver or re-settle. An upstream failure may recover before
settlement; a refused settlement consumes the tested nonce and blocks its reuse.
This does not establish distributed durability, restart recovery or safe blind
retries after uncertain real settlement. No chain transaction is performed.
交付验收显式启用内存 nonce guard，不证明跨实例、重启或不确定真实结算后的自动重付安全。

Use [the troubleshooting guide](acceptance-troubleshooting.md) for missing,
duplicate, invalid-result or failed assertions. Inspect detailed scenario `ok`
values: expected 402/503 responses are part of negative tests.
失败定位见排查指南；负向场景中的 402/503 可以是预期结果。

## Package handoff / 安装包交付

Follow [CONTRIBUTING](../CONTRIBUTING.md) to pack, inspect contents and install the
new tarball into an empty directory. Run the installed commands:
按贡献指南打包、检查内容并安装到空目录，再运行安装包命令：

```sh
bun node_modules/kite-x402-hono/dist/cli.js --help
bun node_modules/kite-x402-hono/dist/acceptance-report.js --json
```

CI performs source checks and installed-package checks and archives evidence.
Source remains in the Unreleased section until an actual release. A local 0.7.0
tarball built from current source is not evidence that registry 0.7.0 contains
these additions. Publishing requires the separate release workflow and registry
verification; this handoff does not publish anything.
当前源码功能仍属 Unreleased；本地构建的 0.7.0 包不能证明公开同版本含这些功能。需另行发布并核实仓库。

## Contribution provenance / 贡献归属

Original diagnostic work and community maintenance are recorded separately.
The original development sequence is:
原创开发与社区维护分开记录，原创开发顺序如下：

| Date       | Original PR                                               | Deliverable / 交付                               |
| ---------- | --------------------------------------------------------- | ------------------------------------------------ |
| 2026-11-18 | [#76](https://github.com/BrKDDD/kite-x402-hono/pull/76)   | Offline configuration preflight / 离线配置预检   |
| 2026-11-19 | [#88](https://github.com/BrKDDD/kite-x402-hono/pull/88)   | Service probes / 服务探测                        |
| 2026-11-20 | [#98](https://github.com/BrKDDD/kite-x402-hono/pull/98)   | Unpaid challenge checker / 挑战检查              |
| 2026-11-21 | [#105](https://github.com/BrKDDD/kite-x402-hono/pull/105) | Cancellation and deadlines / 取消与超时          |
| 2026-11-22 | [#114](https://github.com/BrKDDD/kite-x402-hono/pull/114) | Local acceptance / 本地验收                      |
| 2026-11-23 | [#130](https://github.com/BrKDDD/kite-x402-hono/pull/130) | Simulated delivery / 模拟交付                    |
| 2026-11-24 | [#150](https://github.com/BrKDDD/kite-x402-hono/pull/150) | Retry acceptance / 重试验收                      |
| 2026-11-25 | [#160](https://github.com/BrKDDD/kite-x402-hono/pull/160) | Shareable evidence / 可分享报告                  |
| 2026-11-26 | [#164](https://github.com/BrKDDD/kite-x402-hono/pull/164) | Failure diagnosis / 失败定位                     |
| 2026-11-27 | This handoff / 本交接指南                                 | Reproduction and stage delivery / 复现与阶段交付 |

Day 10 is documentation and validation, not a new payment capability. These are
AI-assisted contributions; the maintainer remains responsible for understanding
and reviewing them. Eligibility is determined by the program organizers.
第十天是文档与核验，不是新增支付功能；AI 辅助贡献仍由维护者理解和审核，活动有效性由组织者认定。
