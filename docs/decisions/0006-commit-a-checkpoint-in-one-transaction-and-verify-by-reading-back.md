# 6. Commit a checkpoint in one transaction and verify by reading back

## Status

Accepted.

## Context

A checkpoint put writes two rows, META and PAYLOAD, and either this
package's own retry layer or the calling application can resend the same
logical write after a lost response. `PutItem` and `DeleteItem` take no
deduplication token and cannot be made to; a one-item, or two-item,
`TransactWriteItems` can, via a `ClientRequestToken` the service honours for
a documented ten-minute window regardless of the caller's own retry policy.

That token helps only while the covering rule is understood precisely.
`docs/evidence/cancelled-transaction-token.md` establishes that a token
whose first use *committed* answers a byte-identical replay from the
service's cache and performs no second write (E-1), but a token whose first
use was *cancelled* by its condition caches nothing at all — the replay is a
fresh evaluation against the table as it stands, which can commit a write
the first attempt never made (E-2). The same file establishes that a
cancelled token still reserves its *parameters*: presenting it again with a
changed request body is refused with `IdempotentParameterMismatchException`
rather than re-evaluated (E-3), so a compare-and-swap that loses and re-pins
must draw a fresh token rather than reuse the spent one.

DynamoDB and S3 are not transactional with each other. When the transaction
itself throws — a timeout, a dropped response — nothing says whether it
committed, and the two wrong guesses are not symmetric: assuming a commit
that did not happen replays a stale checkpoint, and assuming a failure that
was in fact a commit strands or double-releases the S3 object the row now
names.

## Decision

We commit a checkpoint's META and PAYLOAD rows as one `TransactWriteItems`
(`putCheckpoint` in `src/checkpointer/actions/put.ts`), under a
`ClientRequestToken` drawn once per logical write by
`transactIdempotently` (`src/shared/dynamodb/idempotent-write.ts`) — built
once, outside the retry closure, so every attempt of one budget re-sends
the identical request and the token deduplicates it. The budget carries a
deadline at half the token's window, so retrying stops while the token is
still honoured. Neither row carries a condition, so a token-based dedup is
the only thing that can turn a re-send away.

When the transaction throws and S3 offload is configured, we do not assume
either outcome: `verifyCheckpointLanded`
(`src/checkpointer/actions/put.ts`) reads back
whichever row carries an offloaded descriptor and reports one of three
verdicts. `'landed'` reports success without a second write. `'not-landed'`
releases what this attempt uploaded. `'unverified'` — the read itself
failed — leaves the object alone rather than risk deleting one a live row
still needs.

## Consequences

Positive. A lost acknowledgement after a genuine commit is answered from
DynamoDB's own cache rather than replayed, so a retry after a network blip
can neither double-write nor silently orphan the S3 object the committed
row names. The read-back turns an ambiguous transaction failure into one of
three well-defined verdicts instead of a guess.

Negative. Contention on one checkpoint id's transaction meets not only
`ConditionalCheckFailed` but a retryable `TransactionConflict` —
`docs/evidence/transaction-conflict-contention.md` measured it as high as
86 % of requests at twenty concurrent writers (E-5) — so this path costs
more requests under contention than a plain conditional `PutItem` would.
The library's default retry budget absorbs that at roughly 2.6 requests per
logical write (E-6), but a budget configured below the default risks
exhaustion under sustained contention that a plain write would not have
met. The verification read costs one extra strongly consistent `GetItem`,
spent only when there is an offloaded descriptor to check.

Neutral. A cancelled transaction caching nothing is what lets a competing
writer of the same checkpoint id re-evaluate freely rather than being
blocked by a stale rejection. Leaking rather than deleting on an
`'unverified'` verdict is the same asymmetry record 5 already accepts for
S3 cleanup generally: an object nothing references is recoverable, a row
left pointing at nothing is not.
