[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchDrainDetails

# Interface: BatchDrainDetails

Defined in: [shared/errors/base-error.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L39)

What one `BatchWriteItem` drain left behind when it ran out of rounds.

## Properties

### kind

> `readonly` **kind**: `"drain"`

Defined in: [shared/errors/base-error.ts:40](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L40)

***

### retries

> `readonly` **retries**: `number`

Defined in: [shared/errors/base-error.ts:46](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L46)

`UnprocessedItems` rounds spent.

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/base-error.ts:42](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L42)

Writes DynamoDB acknowledged; they persist, since there is no rollback.

***

### unprocessed

> `readonly` **unprocessed**: readonly `WriteRequest`[]

Defined in: [shared/errors/base-error.ts:44](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L44)

The requests DynamoDB did not acknowledge, verbatim, so they can be re-submitted.
