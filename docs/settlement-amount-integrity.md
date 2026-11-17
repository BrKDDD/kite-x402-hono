# Settlement amount integrity

## Problem

`SettlementReconciler` documented `amount` as `bigint | number | string` and
summed it like this:

```ts
try {
  total += BigInt(receipt.amount);
} catch {
  // ignore parsing error for non-standard amount
}
```

Three inputs pass that type but cannot be interpreted as atomic units:
a fractional `number` (`0.05`), a decimal `string` (`"1.5"`), and any `number`
beyond `Number.MAX_SAFE_INTEGER`. `BigInt()` throws on all three, and the `catch`
swallowed it. `record()` performed no validation, so such a settlement was
accepted, counted in `successfulSettlements`, and then contributed nothing to
`totalSettledAmount`.

The result is a plausible but wrong total. Reproduced against the previous source
with three settled receipts:

| input `amount` | `record()` | contribution to `totalSettledAmount` |
| -------------- | ---------- | ------------------------------------ |
| `1000000n`     | accepted   | `1000000n`                           |
| `0.05`         | accepted   | none                                 |
| `"1.5"`        | accepted   | none                                 |

`successfulSettlements` reported `3` while `totalSettledAmount` reported
`1000000n`, which reads as three settlements worth one unit. Nothing in the API
signalled that the total was partial.

`ReceiptMemoryCache` already rejected these values, and the README states one
contract for the package: atomic amounts accept bigint, decimal integer strings,
or safe integers in the uint256 range. The reconciler was the module that
disagreed, silently.

## Change and evidence

The contract now lives in `src/amount.ts` as `tryParseAtomicAmount`, and both
modules use it, so they cannot drift apart again:

- `SettlementReconciler.record()` rejects an unrepresentable amount with
  `Invalid settlement amount` instead of recording it. Validation runs before the
  duplicate check, so a malformed retry is reported rather than ignored.
- `getSummary()` sums a parsed value stored on entry, so no recorded settlement
  can be skipped and the `try`/`catch` is gone.
- `ReceiptMemoryCache.set()` keeps its own `Invalid receipt or TTL` message but
  delegates the amount rule to the shared helper.

Rejection is the point. A caller that passes `0.05` is deciding a currency amount
without knowing the token decimals; the library cannot convert it, so the honest
answer is to fail where the mistake is made, not to under-report later.

Stored receipts keep the caller's original representation, so `amount` still
reads back as `"1000"` or `1000n` as supplied. The parsed form is exposed
additively as `amountAtomic` on `StoredSettlementReceipt`, which is the type
`getByTxHash`, `getByPayer` and `query` now return.

Fifteen tests in `tests/settlement-amount.test.ts` cover the accepted set, each
rejection case, the uint256 bound in both directions, the padded-string bound,
and the aggregator regression: three settlements across `bigint`, integer
`number` and integer `string` total to `7500000n`. The existing 278 tests pass
unchanged, including the receipt-cache cases that pin the pre-existing rule, which
confirms the extraction is behaviour-preserving.

Against the previous source the aggregator case fails: the total is a partial sum
and `record()` accepts the invalid inputs.

## Limits

`SettlementReconciler` still stores receipts in memory with FIFO eviction and no
persistence. Rejecting invalid amounts does not make the total durable or
complete across restarts.

The `number` branch accepts only safe integers, so a caller holding an atomic
amount above `Number.MAX_SAFE_INTEGER` must send `bigint` or a string. That was
already required by the receipt cache, and precision lost before the call cannot
be recovered here.

`amountAtomic` is derived on entry. It is not recomputed if a caller mutates the
object it was given, because `record()` stores a copy; mutating a returned receipt
does not affect stored state.

Decimals are never inferred. An amount is atomic units by definition; converting a
decimal price to atomic units belongs to the caller, which knows the token.
