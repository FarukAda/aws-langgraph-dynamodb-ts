# `TransactionConflictException` under contention on one row

Run conditions: run 1 in [`README.md`](./README.md). Clients built with
`maxAttempts: 1` unless stated otherwise, so the SDK's own retries could not mask
the failures being counted.

## E-5: concurrent conditional transactional writers on one row do meet the retryable `TransactionConflict` failure, not only `ConditionalCheckFailed`

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
contended row does not fail cleanly the way a plain conditional `PutItem` does:
a concurrent attempt on the same row can be turned away with a retryable
`TransactionCanceledException` carrying `CancellationReasons[0].Code ===
'TransactionConflict'` — a genuinely different failure from
`ConditionalCheckFailed`, and one the plain conditional `PutItem` this design
replaces never produced in this probe, at any width tested (0 %). A small rate
of `InternalServerError` (1 in 100 at the worst width) also appears only on the
transactional path. The bare `TransactionConflictException` (rather than a
cancellation reason) is what a *non-transactional* operation sees when it races
a transaction on the same item, not what the transaction itself raises.

**Measured, but not asserted by the paired live test.** The source recorded a
conflict rate — 38 % / 65 % / 86 % at 2 / 5 / 20 concurrent writers — but each
figure is an *aggregate* over several rounds (the five-writer figure is 13 of 20
requests over 4 rounds), and the source kept no per-round breakdown. The
aggregate 3-`ConditionalCheckFailed`-loser count at that width is consistent
with a round where only 1 of 5 writers actually conflicted, so a single live run
of this width could plausibly land far below 65 %. A release-gating test must
not fail on ordinary round-to-round variance it cannot bound, so E-5's test
asserts only that the `TransactionConflict` failure occurs at all — not how
often. The rate above is recorded as the measurement it is, not as a contract
the live test checks.

**What the probe did not cover.** Contention across more than one row at a time
(fan-out contention rather than hot-row contention), rates on a
provisioned-capacity table rather than on-demand, and any per-round breakdown of
the aggregate figures above.

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
