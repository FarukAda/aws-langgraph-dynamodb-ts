[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CompensationFailedDetails

# Interface: CompensationFailedDetails

Defined in: [shared/errors/base-error.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L79)

What a `COMPENSATION_FAILED` error reports besides its trigger, which is `cause`.

## Properties

### rollbackError

> `readonly` **rollbackError**: `Error`

Defined in: [shared/errors/base-error.ts:86](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L86)

Why the append could not be undone or settled: the rollback's own
failure (itself often a `BATCH_WRITE_INCOMPLETE`), the read-back's
failure, or the write's own failure when some attempt of it may still
be applied.
