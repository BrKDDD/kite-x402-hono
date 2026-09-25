# Contributing

Use Bun 1.4.2 and Node.js 22. Install with `npm ci` (package-lock.json is the
canonical dependency lock), then run `npm run check` and `npm run test:coverage`.
Keep the official Kite environment names and `/v1/*` route prefix compatible.
Never include real credentials, wallet keys, `.env`, or fabricated payment receipts.

Any change affecting payments must test missing/invalid payment, successful
verify -> upstream -> settle ordering, upstream failure, and settlement failure.
Keep simulated-facilitator tests distinct from any real paid-call evidence.

## Release

1. Run checks and `npm audit --omit=dev --audit-level=high`.
2. Run `npm pack --dry-run`, review contents, then `npm pack`.
3. Install the tarball into an empty directory and exercise CLI help and health.
4. Confirm the GitHub CI result for the commit being released.
5. Authenticate to npm interactively; never put tokens or OTPs in committed files.
6. Publish the reviewed tarball for the version in package.json (for example,
   `npm publish kite-x402-hono-0.2.0.tgz --access public`).
7. Verify registry version/integrity, then tag the exact source revision.

Do not claim a version has been published until the npm registry confirms it.
