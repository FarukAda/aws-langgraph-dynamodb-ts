# 14. Retry through one classifier and bound every loop

## Status

Accepted.

## Context

This package issues DynamoDB requests from many call sites — a single
`GetItem`, a paginated `Query` or `Scan`, a `TransactWriteItems`, a
`BatchWriteItem` re-submitting `UnprocessedItems` — and each of those loops
needs to know the same thing: whether a given failure is transient and
worth another attempt, or permanent and worth surfacing immediately. AWS's
own retryability signals are scattered across several places on an
error — its name, an HTTP status the SDK could not map to a modelled
exception, the SDK's own `$retryable` trait, and, for a
`TransactWriteItems`, per-item cancellation reasons that can mix a
transient cause with a permanent one in the same response. Any call site
that decided this locally would eventually decide it differently from the
others.

A retry, a page walk and a `BatchWriteItem` drain loop share a second
problem besides classification: each is, in principle, unbounded. A
listing with no cap given would read forever against a table that keeps
growing; a drain against `UnprocessedItems` that never shrinks would spin
forever waiting for capacity that never arrives.

## Decision

We decide retryability in one function, `isRetryableError`
(`src/shared/dynamodb/retry-classifier.ts`). Every DynamoDB call reaches it
through `withRetry` / `withDynamoDBRetry` (`src/shared/dynamodb/retry.ts`);
S3's own transient signals (`isTransientS3Error`,
`src/shared/codec/s3/retry.ts`) are `isRetryableError` given a longer token
list, plugged into `withRetry` as `isRetryable` on the read and write
paths, and consulted directly by the one hand-rolled, best-effort loop —
orphan cleanup after a failed write — that is not itself built on
`withRetry`. It checks, in order: whether a
transaction cancellation's reasons are *all* transient (a mixed
cancellation is never retried, since a permanent reason shares the same
HTTP status as a transient one); the SDK's own retryable trait; a
transient HTTP status, for a failure the SDK could not map to a name; and
finally an exact match against a token list, never a substring match.
`test/static/retry-options.test.ts` fails the build for any
`withDynamoDBRetry` call outside the retry module itself that does not
pass the adapter's own retry options through, so a call site cannot
silently fall back to defaults that ignore a caller's configured policy.

Every loop that is not a single request is bounded. A retry budget has
`maxAttempts`, plus, for a call carrying a `ClientRequestToken`, a deadline
inside the token's idempotency window (record 6). A page walk
(`paginateQuery`, `paginateScan`) takes `maxItems` and `maxIterations`,
raising `ResultTruncatedError` rather than returning a silently partial
result when either is reached. A `BatchWriteItem` drain
(`drainUnprocessedWrites`, `src/shared/dynamodb/drain-unprocessed.ts`)
re-submits `UnprocessedItems` for at most `maxRetries` rounds before
raising `BatchWriteIncompleteError` naming what did and did not persist.

## Consequences

Positive. A new call site inherits a classifier already checked against
real DynamoDB behaviour — the transaction-cancellation rule exists because
a bare `TransactionConflictException` and a cancellation carrying that same
reason are the same underlying condition observed two different ways —
rather than reimplementing its own guess. No loop in the package can spin
indefinitely against a table or a service that never recovers; every one
of them ends in a typed error that says how far it got.

Negative. Every one of those bounds is a cap an application-level operation
can hit under enough load or contention, converting what would otherwise
be "slow" into "failed", and a caller that wants a larger table walk or a
longer retry budget has to configure it explicitly rather than getting it
for free by omission. The classifier itself is a single point every
retryable failure now depends on; a wrong call there is wrong everywhere
at once, rather than contained to one call site.

Neutral. `RetryOptions.isRetryable` lets a call site substitute its own
classifier entirely rather than the shared token list, which several
non-DynamoDB paths use to reuse the retry loop's structure — its backoff,
its abort handling, its budget — for a different service's failure
vocabulary.
