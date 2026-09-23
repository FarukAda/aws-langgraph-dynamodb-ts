[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchPassDetails

# Interface: BatchPassDetails

Defined in: [shared/errors/base-error.ts:54](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L54)

The tally of a pass that attempted every chunk (`unit: 'chunk'`, 25-row
`BatchWriteItem` chunks) or every row (`unit: 'row'`, one conditional delete
per row) before reporting.

## Properties

### failedChunks

> `readonly` **failedChunks**: readonly `Error`[]

Defined in: [shared/errors/base-error.ts:60](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L60)

Each failing chunk's or row's own error.

***

### kind

> `readonly` **kind**: `"pass"`

Defined in: [shared/errors/base-error.ts:55](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L55)

***

### succeededChunks

> `readonly` **succeededChunks**: `number`

Defined in: [shared/errors/base-error.ts:57](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L57)

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/base-error.ts:62](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L62)

Individual writes confirmed persisted across the whole pass.

***

### totalChunks

> `readonly` **totalChunks**: `number`

Defined in: [shared/errors/base-error.ts:58](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L58)

***

### unit

> `readonly` **unit**: `"chunk"` \| `"row"`

Defined in: [shared/errors/base-error.ts:56](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L56)
