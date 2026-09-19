# Security

Use this template with a trusted upstream and a trusted facilitator. Payment
cryptography and on-chain verification are delegated to the official x402 SDK
and the configured facilitator; the proxy does not independently validate chain
state. Pin dependencies and review updates before upgrading.

Run behind HTTPS with request-rate limits. Keep the receiving wallet separate
from application secrets. No signing key belongs in this wrapper. Never log
payment signatures, authorization headers, full request bodies or `.env`.

This is a bounded-response template, not a hardened multi-tenant API gateway.
An upstream can perform an action before settlement fails. Idempotency and
reconciliation for such actions must be provided by the upstream/application.
Do not automatically retry an indeterminate settlement.

Report security issues using GitHub's private vulnerability reporting when
enabled; do not publish credentials or exploitable details in public issues.
