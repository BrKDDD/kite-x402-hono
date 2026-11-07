# Changelog

## Unreleased

- Review PR #62: export a structured JSON error handler for explicit `app.onError` registration, with validated request IDs, generic no-store 500 responses, optional server-only stacks, and isolated logging failures.

## 0.5.0

- Integrate reviewed PRs #52–#61, including fee snapshot isolation, atomic response cache updates, and per-network settlement reconciliation.
- Export optional readiness snapshots, origin validators, bounded JWT revocations, settlement notifications, trusted-identity sliding-window middleware, and HMAC verification.
- Repair mutable snapshots, stateful origin regex matching, unbounded revocations, unsafe event amounts, spoofable limiter keys, and unsigned webhook timestamps. See docs/pr-review-2026-11-06.md for API contracts and integration limits.

## 0.4.0

- Integrate and review community PRs #22, #24, #28–#29, #31, #33–#51.
- Isolate paid idempotent retries; keep active reservations and nonce leases owner-bound; default to socket IP identity and validate IPv6 firewall rules.
- Repair optional component authentication, cache privacy/bounds, receipt retention/indexing, probe cleanup/coalescing, queue timers and policy enforcement. Export optional library utilities without automatically enabling them.
- Upgrade official x402 SDK packages to 2.29.0 and Hono to 4.13.16; retain paid ordinary OPTIONS explicitly after SDK route-matching changes.
- Add independent cryptographic and security regression coverage. See docs/pr-review-2026-11-04.md for component limits.

## 0.3.3

- Implement graceful CLI shutdown on `SIGINT`/`SIGTERM` with active request draining (`server.stop(false)`) and configurable `SHUTDOWN_TIMEOUT_MS`.
- Add configuration validation and unit tests for `SHUTDOWN_TIMEOUT_MS` (range 1–60000 ms, default 10000 ms).
- Update documentation and environment example with graceful shutdown details.

- Add standard Kubernetes `GET /livez` liveness probe endpoint returning `200 {"ok":true,"status":"alive"}` with `Cache-Control: no-store` independent of external network or facilitator status.
- Add `X-Response-Time` performance timing header across all responses measuring wrapper execution latency.
- Expose `X-Response-Time` in CORS headers (`Access-Control-Expose-Headers`) for web dApps and browser clients.
- Add unit tests verifying `/livez`, timing header formatting, and CORS exposure.

- Preserve configured CORS headers on settlement refusals and facilitator errors
  so allowed browser clients can inspect failure responses and payment receipts.

## 0.3.2

- Forward conditional 304 responses through settlement while refusing other 3xx statuses.
- Add facilitator readiness, response request IDs and early declared-body size checks.
- Add operational metrics endpoint `GET /stats` providing uptime, active concurrency utilization, and payment challenge/success counters without contacting the facilitator.
- Validate readiness protocol/version and CORS configuration; preserve paid OPTIONS handling.
- Add configurable CORS support via `CORS_ORIGIN` (`*` or specific HTTP(S) origin) to allow browser dApps, Web3 extensions, and Kite AI web agents to interact with paid endpoints.
- Allow preflight `OPTIONS` requests to receive `204 No Content` with appropriate `Access-Control-Allow-*` headers without requiring payments.
- Expose essential x402 payment headers (`Payment-Required`, `Payment-Response`, `Retry-After`) to cross-origin browser clients.
- Add comprehensive CORS integration tests covering preflight, 402 challenges, paid responses, origin filtering, and configuration validation.
- Add automated tests in `tests/stats.test.ts` verifying metrics reporting, challenge recording, and zero-facilitator dependency.
- Update English and Chinese documentation and `.env.example`.

## 0.3.1

- Make rejected-body and redirect stream cleanup non-blocking so stalled producer
  cancellation cannot retain a request slot. Preserve original errors when cleanup fails.
- Cancel unfinished reads, including already-aborted requests, and release reader locks.
- Add nine regression tests for stalled/rejected cleanup, capacity recovery, aborts
  and byte-preserving successful reads.

## 0.3.0

- Add `FACILITATOR_TIMEOUT_MS` (default 90000, range 1–300000) and validate
  environment and programmatic configuration while preserving older Config objects.
- Apply the official SDK HTTP abort mechanism to facilitator capability discovery,
  payment verification and settlement, including response headers and bodies.
- Add seven real HTTP timeout tests covering failure responses, concurrency-slot
  recovery, health availability and absence of automatic payment retries.
- Update English/Chinese documentation, CLI help and the environment example.

The timeout applies per HTTP attempt; SDK initialization backoff may extend the
whole request. Custom facilitator clients manage their own deadlines. Settlement
timeout leaves the payment outcome unknown and does not guarantee no charge.

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
