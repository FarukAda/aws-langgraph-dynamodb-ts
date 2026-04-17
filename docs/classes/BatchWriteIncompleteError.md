[**AWS LangGraph DynamoDB TypeScript v0.2.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchWriteIncompleteError

# Class: BatchWriteIncompleteError

Defined in: [shared/utils/batch-write.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/batch-write.ts#L35)

Error thrown when `batchWriteWithRetry` / `batchWriteAllWithRetry` exhaust
their UnprocessedItems retry budget. Carries enough information for the
caller to reason about recovery: how many items persisted before the giveup,
how many are still un-acked, and which items remained un-acked.

*Partial-success semantics:* DynamoDB's BatchWriteItem is not atomic across
items in a batch, and `batchWriteAllWithRetry` issues a sequence of 25-item
batches. When this error is thrown, any item not listed in `unprocessed` has
already been acked by DynamoDB. Callers that need all-or-nothing must drive
reconciliation from `unprocessed` (retry, compensating delete, or surface to
the user) — this helper cannot roll back the successful rows for you.

## Extends

- `Error`

## Constructors

### Constructor

> **new BatchWriteIncompleteError**(`succeededCount`, `unprocessed`, `retries`): `BatchWriteIncompleteError`

Defined in: [shared/utils/batch-write.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/batch-write.ts#L39)

#### Parameters

##### succeededCount

`number`

##### unprocessed

`WriteRequest`[]

##### retries

`number`

#### Returns

`BatchWriteIncompleteError`

#### Overrides

`Error.constructor`

## Properties

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/utils/batch-write.ts:36](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/batch-write.ts#L36)

***

### unprocessed

> `readonly` **unprocessed**: `WriteRequest`[]

Defined in: [shared/utils/batch-write.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/309842e8e569d78757523036e9b5315c5dae8193/src/shared/utils/batch-write.ts#L37)
