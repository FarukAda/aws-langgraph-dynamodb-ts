[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchDrainDetails

# Interface: BatchDrainDetails

Defined in: [shared/errors/base-error.ts:49](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L49)

What one `BatchWriteItem` drain left behind when it ran out of rounds.

## Properties

### kind

> `readonly` **kind**: `"drain"`

Defined in: [shared/errors/base-error.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L50)

***

### retries

> `readonly` **retries**: `number`

Defined in: [shared/errors/base-error.ts:56](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L56)

`UnprocessedItems` rounds spent.

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/base-error.ts:52](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L52)

Writes DynamoDB acknowledged; they persist, since there is no rollback.

***

### unprocessed

> `readonly` **unprocessed**: readonly `WriteRequest`[]

Defined in: [shared/errors/base-error.ts:54](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L54)

The requests DynamoDB did not acknowledge, verbatim, so they can be re-submitted.
