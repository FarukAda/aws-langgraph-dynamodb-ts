# `TransactionConflictException` under contention on one row

Run conditions: run 1 in [`README.md`](./README.md). Clients built with
`maxAttempts: 1` unless stated otherwise, so the SDK's own retries could not mask
the failures being counted.

## E-5: under concurrent writers on one row, most attempts come back as a retryable conflict rather than a clean win-or-lose

**Request** — N writers each send the library's exact write shape (a one-item
conditional `TransactWriteItems`, `ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`,
a fresh token) against the same row, several rounds per width; a control arm sends
the same condition as a plain conditional `PutItem`.

**Response**

```
--- one-item TransactWriteItems, conditional (20 writers x 5 rounds = 100 requests) ---
    83  TransactionCanceledException[TransactionConflict]
    11  TransactionCanceledException[ConditionalCheckFailed]
     5  resolved
     1  InternalServerError

--- plain conditional PutItem (the control) (20 writers x 5 rounds = 100 requests) ---
    95  ConditionalCheckFailedException
     5  resolved

  width= 2  requests=  8  conflicts=  3 (38%)
  width= 5  requests= 20  conflicts= 13 (65%)
  width=20  requests= 80  conflicts= 69 (86%)
  plain-put at every width: 0% conflicts
```

**What this settles.** A one-item conditional `TransactWriteItems` against a
contended row converts most would-be condition failures into a retryable
`TransactionCanceledException` carrying `CancellationReasons[0].Code ===
'TransactionConflict'` — 38 % of attempts at two concurrent writers, rising with
width, against 0 % for the plain conditional `PutItem` it replaces at every width
tested. A small rate of `InternalServerError` (1 in 100 at the worst width) also
appears only on the transactional path. The bare `TransactionConflictException`
(rather than a cancellation reason) is what a *non-transactional* operation sees
when it races a transaction on the same item, not what the transaction itself
raises.

**What the probe did not cover.** Contention across more than one row at a time
(fan-out contention rather than hot-row contention), and rates on a
provisioned-capacity table rather than on-demand.

## E-6: the library's default retry budget absorbs the conflicts

**Request** — 20 transactional writers per round, sent through this package's own
idempotent-write helper under its **default** retry policy (`maxAttempts: 5`,
`baseDelayMs: 100`, `maxDelayMs: 5000`, full jitter), several rounds.

**Response**

```
20 transactional writers under the library's DEFAULT retry budget x 3 rounds (157 requests)
    57  terminal:TransactionCanceledException[ConditionalCheckFailed]
     3  resolved
  => 0 of 60 writers ended in RetryExhaustedError instead of a clean win/lose (0.0%)
```

**What this settles.** Under the worst contention width tested, every logical
write still reaches a clean terminal outcome — one winner, the rest turned away by
the condition — and none exhausts the retry budget, at a cost of roughly 2.6
requests per logical write (157 requests for 60 writes).

**What the probe did not cover.** A retry budget deliberately set below the
default, or contention sustained long enough to matter for the ten-minute
`ClientRequestToken` window rather than the few seconds each round took.
