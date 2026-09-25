# Changelog

## 0.2.0

- Bound the complete payment lifecycle with `MAX_CONCURRENT_REQUESTS` (default
  64). Excess requests receive a non-cacheable 503 `service_busy` and Retry-After
  before payment verification. Slots remain held until settlement completes.
- Release slots on success and failure; keep health checks independent.
- Add deterministic concurrency, settlement, initialization and recovery tests.
- Include Chinese documentation and updated configuration/CLI guidance.
- Make the CI package installation check follow the package version automatically.

This release adds a default concurrency cap. Operators needing a different limit
can set a value from 1 to 10000. The limit is per app instance, not distributed;
it does not implement payment deduplication or automatic payment retries.

## 0.1.0

- Initial Kite mainnet/testnet Bun/Hono x402 proxy, payment lifecycle tests,
  bounded bodies, credential filtering and installable npm package.
