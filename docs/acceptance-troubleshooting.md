# Acceptance troubleshooting / 验收排查

These commands run synthetic local fixtures, not production wallets or chain transactions.
这些命令只运行本地模拟，不操作生产钱包或链上交易。

## Reproduce / 重现

From a clean checkout with Bun installed / 在安装 Bun 的干净检出目录：

```sh
npm ci
npm run build
bun dist/acceptance-report.js --json > acceptance-summary.json
bun dist/acceptance-report.js > acceptance-summary.md
```

Each command performs a fresh run. Exit 0 means all assertions passed; 1 means failure.
每条命令重新执行验收，退出 0 才代表通过。JSON 的 schemaVersion 1 新增 reason 字段，旧字段不变。

## Locate / 定位

| Reason           | Meaning / 含义                           | Action / 操作                                                                   |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------------------------- |
| passed           | Known check passed / 已知检查通过        | No action / 无需处理                                                            |
| missing          | Expected check absent / 缺少检查项       | Rebuild and verify runner versions / 重新构建并核对版本                         |
| duplicate        | Repeated check name / 重复检查名         | Check aggregation and runner compatibility / 核对汇总及版本                     |
| invalid_result   | Result is not a boolean / 结果不是布尔值 | Inspect report structure; never coerce strings / 核对结构，不把字符串强转为通过 |
| assertion_failed | Check explicitly failed / 断言失败       | Run the corresponding detailed suite / 运行对应详细验收                         |

```sh
bun dist/local-acceptance.js --json
bun dist/delivery-acceptance.js --json
```

Diagnostics failures: check local loopback binding permissions, Bun compatibility and
configuration/challenge schema changes. Fixed fixtures ignore merchant environment variables;
changing a real PAY_TO or sending funds cannot repair this simulation.
诊断失败先检查本机端口权限、Bun 版本与配置/挑战结构；模拟忽略商户环境，修改真实收款地址或充值不能修复它。

Delivery/retry failures: compare reported statuses and call order with the named scenario.
A 402 or 503 can be expected in a negative case; inspect `ok`, not status alone.
Retry checks explicitly enable an in-memory nonce guard. Do not automatically retry real
payments after refused or uncertain settlement.
交付/重试失败需核对场景的状态与顺序。负向场景的 402/503 是预期结果，以 ok 为准；不要盲目重付真实交易。

If every row passes but a suite fails, inspect its overall result, scope, array completeness,
cleanup and diagnostic payment counts. A cleanup or execution failure can fail the suite
without changing an earlier successful row.
若所有行通过但套件失败，检查总体结果、scope、数组完整性、清理及诊断支付计数；早先通过的行不能覆盖执行/清理失败。

## Share / 分享

Share the sanitized summary, source commit and CI URL separately. Review detailed outputs
before sharing; never attach .env, keys, payment signatures or full request logs. Reports
are assertions, not authenticated execution proof, release confirmation or chain receipts.
分享脱敏摘要，并另附源码提交和 CI 链接；不要附环境文件、私钥、签名或完整请求日志。摘要不是交易凭证或发布证明。
