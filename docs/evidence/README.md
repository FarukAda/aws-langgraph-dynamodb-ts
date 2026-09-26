# Live-AWS evidence

Each file records a behaviour DynamoDB or S3 exhibits that AWS documents
incompletely or not at all, together with the raw request and response that
established it.

A behaviour recorded here becomes citable only when **both** exist: the evidence
file, and a live test — in `test/aws`, named after the claim it asserts — that
fails if AWS changes the behaviour. The file alone goes stale silently; the test
alone cannot be checked by a reviewer without AWS credentials.

Nothing runs this live tier on a schedule, deliberately: one suite calls Bedrock,
and a scheduled job that retried or looped would bill the account with nobody
watching. It runs on every `v*` release tag (`integration-live.yml`), and the
release does not publish unless that run passed (decision record 18). A
maintainer can also run it locally with their own credentials
(`AWS_REGION=eu-central-1 npm run test:aws`; every `E-` claim alone with
`-t "E-"`). So between releases a claim is only as fresh as the last run that
checked it — the date of each run is stated below for exactly that reason; re-run
the suite before relying on one of these claims in a decision that matters.

## Run conditions

Every probe below was issued against the raw SDK, never through this package, so
nothing in `src/` could colour the answer, and with `maxAttempts: 1` so the SDK's
own retries could not mask a response. Each run created its own DynamoDB table or
S3 bucket and deleted it afterward.

Every run below used the same AWS account, so no difference between them is
explained by account-level quota or configuration. The account is not named here:
it identifies the maintainer's, and nothing in a probe can be re-derived from it.

| Run | Date | Region | SDK | Resources |
|---|---|---|---|---|
| 1 | 2026-09-17 | `eu-central-1` | `@aws-sdk/client-dynamodb@3.1132.0`, `@aws-sdk/client-s3@3.1132.0` | DynamoDB tables (on-demand) and S3 buckets, one per probe, deleted after |
| 2 | 2026-09-19 | `eu-central-1` | `@aws-sdk/client-dynamodb@3.1132.0` | One DynamoDB table (on-demand), deleted after |
| 3 | 2026-09-19 | `eu-central-1` | `@aws-sdk/client-dynamodb@3.1132.0` | One DynamoDB table (on-demand), deleted after |
| 4 | 2026-09-27 | `eu-west-1` | `@aws-sdk/client-s3@3.1132.0` | S3 buckets, one per suite, deleted after (E-8 and E-12 re-run) |

## Claims settled

| Claim | Description | File | Test |
|---|---|---|---|
| E-1 | A token whose first use completed answers a replay from the cache and performs no second write | [cancelled-transaction-token.md](cancelled-transaction-token.md) | `test/aws/real-aws-idempotency.test.ts` |
| E-2 | A token whose first use was cancelled caches no result, and a replay is re-evaluated | [cancelled-transaction-token.md](cancelled-transaction-token.md) | `test/aws/real-aws-idempotency.test.ts` |
| E-3 | A cancelled token still reserves its parameters — a changed body is refused, not re-evaluated | [cancelled-transaction-token.md](cancelled-transaction-token.md) | `test/aws/real-aws-idempotency.test.ts` |
| E-4 | `CancellationReasons[].Item` through `DynamoDBDocument` is raw, unmarshalled `AttributeValue` data | [transaction-rejected-row.md](transaction-rejected-row.md) | `test/aws/real-aws-idempotency.test.ts` |
| E-5 | Concurrent conditional transactional writers on one row do meet the retryable `TransactionConflict` failure, not only `ConditionalCheckFailed` | [transaction-conflict-contention.md](transaction-conflict-contention.md) | `test/aws/real-aws-idempotency.test.ts` |
| E-6 | The library's default retry budget absorbs the conflicts | [transaction-conflict-contention.md](transaction-conflict-contention.md) | `test/aws/real-aws-idempotency.test.ts` |
| E-7 | `PutObject` with `If-None-Match: *` against an existing key is refused | [s3-conditional-create.md](s3-conditional-create.md) | `test/aws/real-aws-s3.test.ts` |
| E-8 | Racing conditional creates of one key: exactly one wins, and no loser overwrites it | [s3-conditional-create.md](s3-conditional-create.md) | `test/aws/real-aws-s3.test.ts` |
| E-9 | `GetBucketVersioning` distinguishes never-versioned, enabled and suspended | [s3-versioning-and-lifecycle.md](s3-versioning-and-lifecycle.md) | `test/aws/real-aws-s3-versioning.test.ts` |
| E-10 | Deleting a versioned object leaves a delete marker, and the prior version stays readable by id | [s3-versioning-and-lifecycle.md](s3-versioning-and-lifecycle.md) | `test/aws/real-aws-s3-versioning.test.ts` |
| E-11 | A lifecycle rule cannot share one `Expiration` between `Days` and `ExpiredObjectDeleteMarker` | [s3-versioning-and-lifecycle.md](s3-versioning-and-lifecycle.md) | `test/aws/real-aws-s3-lifecycle.test.ts` |
| E-12 | Under suspended versioning, writes get a null version id and old versions survive untouched | [s3-versioning-and-lifecycle.md](s3-versioning-and-lifecycle.md) | `test/aws/real-aws-s3-versioning.test.ts` |
| E-13 | The idempotency cache covers a transactional `Delete` exactly as it covers a `Put` | [transactional-delete-idempotency.md](transactional-delete-idempotency.md) | `test/aws/real-aws-delete.test.ts` |
| E-14 | A conditional `DeleteItem` against an already-gone row is refused with no item attached | [conditional-delete.md](conditional-delete.md) | `test/aws/real-aws-delete.test.ts` |
| E-15 | A document-path condition evaluates to false, never `ValidationException`, when the guarded attribute or its inner field is absent | [conditional-delete.md](conditional-delete.md) | `test/aws/real-aws-delete.test.ts` |
| E-16 | A successful conditional delete is charged capacity sized to the row; a refused one reports none | [delete-capacity.md](delete-capacity.md) | `test/aws/real-aws-delete-batch.test.ts` |
| E-17 | `BatchWriteItem` accepts a condition on a `DeleteRequest` and silently ignores it | [batch-write-condition.md](batch-write-condition.md) | `test/aws/real-aws-delete-batch.test.ts` |
