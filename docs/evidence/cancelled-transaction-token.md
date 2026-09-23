# A `ClientRequestToken`'s idempotency window on `TransactWriteItems`

Run conditions: run 1 in [`README.md`](./README.md).

All three probes use one-item `TransactWriteItems` calls through `DynamoDBDocument`,
built with `maxAttempts: 1` so the SDK's own retries could not mask a result. Every
send used the exact shape the library sends: a `Put`, a `ConditionExpression` and a
`ClientRequestToken`.

## E-1: a token whose first use completed answers a replay from the cache and performs no second write

**Request** — send a conditional `Put` with a fresh token; once it resolves, delete
the row outright (bypassing the library); then resend the byte-identical request,
token included.

**Response**

```
first send status 200
row deleted; replaying the identical request...
replay: resolved status=200
row after replay: null
```

The replay answered `200` without re-executing: had it been re-evaluated, the row
would exist again (the condition — "row absent" — would have been satisfied a
second time, once more producing a write). It did not, so the row stayed deleted.

**What this settles.** A `ClientRequestToken` whose first use *committed* is cached
for the documented ten-minute window: a byte-identical replay is answered from the
cache rather than re-applied. This is the assumption the whole offload-durability
design rests its "a lost acknowledgement is safe to retry" claim on.

**What the probe did not cover.** The cache's ten-minute expiry itself — the probe
ran in seconds, not minutes, so the boundary where a token stops being honoured was
not exercised.

## E-2: a token whose first use was cancelled caches no result, and a replay is re-evaluated

**Request** — write a blocking row; send a conditional `Put` with a fresh token
against it (the condition fails); remove the blocker; resend the identical request,
same token.

**Response**

```
blocker row written
first send threw:
{
  "name": "TransactionCanceledException",
  "message": "Transaction cancelled, please refer cancellation reasons for specific reasons [ConditionalCheckFailed]",
  "CancellationReasons": [
    { "Item": { "PK": {"S":"l2"}, "SK": {"S":"row"}, "blocker": {"BOOL":true} },
      "Code": "ConditionalCheckFailed", "Message": "The conditional request failed" }
  ]
}
blocker removed; replaying the identical request with the SAME token...
replay: resolved status=200
row after replay: {"SK":"row","PK":"l2","marker":"replay"}
```

The replay did not merely fail again: the blocker was gone by then, so the
condition it re-evaluated was now true, and it committed a fresh write. That is the
strongest possible form of "not cached" — a cached result would have answered `200`
and left the row exactly as the first attempt did (absent), not written it.

**What this settles.** A token whose first use was *cancelled* never completes, so
there is no cached result to serve; a replay is a fresh evaluation against the
table as it stands when the replay lands, which can commit a write the first
attempt never made. A write whose first attempt was rejected by its condition
carries no idempotency at all.

**What the probe did not cover.** Whether the same holds for a transactional
`Delete` rather than a `Put` was answered separately, by the same shape against a
delete: a cancelled delete-transaction token, resent unchanged, threw
`IdempotentParameterMismatchException` rather than answering from a cache — see
E-3, which is the fact both operations share.

## E-3: a cancelled token still reserves its parameters — a changed body is refused, not re-evaluated

**Request (`Put` side)** — the same cancel-then-replay shape as E-2, but the
*second* send changes the item body while reusing the same token.

**Response**

```
first send (blocked): TransactionCanceledException[ConditionalCheckFailed]
blocker removed; same token, CHANGED body...
threw IdempotentParameterMismatchException
row after: null
```

**Request (`Delete` side)** — a one-item transactional `Delete` guarded by a
revision condition that is false on the first send; the second send carries the
same token with the condition re-pinned onto the row's real revision (a changed
body).

**Response**

```
first use (condition false): TransactionCanceledException [ConditionalCheckFailed]
same token, CHANGED body: IdempotentParameterMismatchException
row after: {"PK":"p","rev":"R1","SK":"d2"}
```

Both operations answer the same way: `IdempotentParameterMismatchException`, not a
fresh evaluation, and the row is left exactly where the first (rejected) attempt
left it.

**What this settles.** Unlike the *result*, a cancelled token's *parameters* are
reserved for the whole idempotency window: presenting the same token with a
changed request body is refused rather than evaluated. This is what makes a
compare-and-swap re-pin need a **fresh** token after a cancellation —
`IdempotentParameterMismatchException` is not in this package's retryable-error
list and is handled nowhere, so reusing the spent token would surface a raw SDK
error to a caller.

**What the probe did not cover.** A change to the token's *other* request fields
(table name, key attributes) rather than the item body — only the body was varied,
since that is the only field a real re-pin changes.
