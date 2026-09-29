# 25. Treat a write that got no answer as one that may still land

## Status

Accepted.

## Context

Record 6 settles an ambiguous write by reading its row back: a row holding the
write's own identity means it landed, anything else means it did not, and only
the second answer releases what the write uploaded. That reasoning holds for a
write DynamoDB answered. It does not hold for a write this side cut short. A
cancel through the caller's `AbortSignal`, the SDK request timeout, and a
dropped connection each end the client's wait, not the service's work: a
request DynamoDB has already received is applied after the client gave up on
it, and a read issued in between finds nothing. The chat-history append went
further and did not read a chunk back after a cancel at all. Either way a row
that commits after the read names objects that are gone. A checkpointer or
store read of that row fails outright; a chat-history read of that message
fails the same way under `onCorruptMessage: 'throw'`, or is silently dropped
with an `error` log under the default `'skip'` — either way it is
permanently unreadable.

Two further answers say the same about a write DynamoDB *did* respond to.
AWS's `TransactWriteItems` API reference documents
`TransactionInProgressException` as the answer to a request that reuses a
`ClientRequestToken` still being processed — proof by definition that an
earlier attempt under that token reached the service and has not yet been
decided — and its *Recommended Settings* timeline shows an attempt that was
cut short still completing seconds later, while the attempts sent after it are
answered normally. The DynamoDB Developer Guide's error-handling page states,
of an HTTP 500 (`InternalServerError`), that it "may have succeeded or
failed"; the library treats every 5xx the same way. Neither answer is a
refusal, and a strict single-attempt read of "the last thing that happened"
misses both: `TransactWriteItems` is sent under one token for the whole retry
budget, so an *earlier* attempt can be the one still in flight while a later
one is answered outright.

## Decision

A failed write is judged by how its whole retry budget ended, not only its
last attempt (`mayStillLand` in `src/shared/dynamodb/idempotent-write.ts`,
over `mayStillBeInFlight` in `src/shared/errors/classify.ts`). A write may
still land when it was cancelled, or when any attempt of it — (i) ended
without an answer, (ii) was answered `TransactionInProgressException`, or
(iii) was answered with a server error (5xx). `withRetry` keeps that record
across every attempt it makes and carries it on the `RETRY_EXHAUSTED` error it
throws (`retryBudgetMayStillLand` in `src/shared/errors/errors.ts`). For such
a write, a read that finds the row absent, or still in the state the write was
pinned to, is `'unverified'` rather than `'not-landed'` (`settledVerdict`),
and an unverified write keeps its uploads. A read that finds the row held by a
write the pin excludes is still a definite answer. Each write site checks its
signal before sending: a write the cancel came before is never sent, and its
uploads are released at once. The chat-history append reads back every
failure but a refusal the service answered, rolls back a chunk that landed
although the cancel cut its answer short, and reports an unsettled chunk as
`COMPENSATION_FAILED` — the session cannot be said to be restored — except
after a cancel, which stays `ABORTED`.

## Consequences

Positive. No ordering of a cancel, a timeout and a slow commit leaves a live
row naming a deleted object; the worst outcome is a leaked object.

Negative. More objects leak — every write cut short keeps its uploads, including
some that never reached DynamoDB — and they are reclaimed by the lifecycle rule
where a `ttl` is set, or by a sweep of the offload prefix where none is. An
append whose failing chunk cannot be settled fails with `COMPENSATION_FAILED`
rather than with the chunk's own error, so a caller retrying on an ordinary
error does not duplicate messages that may already be there. Two shapes the
rule does not cover: a non-retryable answered error rethrown after an earlier
open attempt — it needs the table, its permissions or the credentials to
change mid-budget for the later, unrelated attempt to be refused outright
while an earlier one is still undecided; and SDK-internal retries of an
injected client, each hidden inside what this library sees as a single
attempt — the README already tells a caller to turn those off with
`maxAttempts: 1`.

Neutral. A write the service answered keeps exactly the read-back record 6
describes.
