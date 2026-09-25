[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CompensationFailedDetails

# Interface: CompensationFailedDetails

Defined in: [shared/errors/base-error.ts:79](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L79)

What a `COMPENSATION_FAILED` error reports besides its trigger, which is `cause`.

## Properties

### rollbackError

> `readonly` **rollbackError**: `Error`

Defined in: [shared/errors/base-error.ts:81](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L81)

Why the rollback itself could not finish; itself often a `BATCH_WRITE_INCOMPLETE`.
