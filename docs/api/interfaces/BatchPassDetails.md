[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / BatchPassDetails

# Interface: BatchPassDetails

Defined in: [shared/errors/base-error.ts:64](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L64)

The tally of a pass that attempted every chunk (`unit: 'chunk'`, 25-row
`BatchWriteItem` chunks) or every row (`unit: 'row'`, one conditional delete
per row) before reporting.

## Properties

### failedChunks

> `readonly` **failedChunks**: readonly `Error`[]

Defined in: [shared/errors/base-error.ts:70](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L70)

Each failing chunk's or row's own error.

***

### kind

> `readonly` **kind**: `"pass"`

Defined in: [shared/errors/base-error.ts:65](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L65)

***

### succeededChunks

> `readonly` **succeededChunks**: `number`

Defined in: [shared/errors/base-error.ts:67](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L67)

***

### succeededCount

> `readonly` **succeededCount**: `number`

Defined in: [shared/errors/base-error.ts:72](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L72)

Individual writes confirmed persisted across the whole pass.

***

### totalChunks

> `readonly` **totalChunks**: `number`

Defined in: [shared/errors/base-error.ts:68](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L68)

***

### unit

> `readonly` **unit**: `"chunk"` \| `"row"`

Defined in: [shared/errors/base-error.ts:66](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/shared/errors/base-error.ts#L66)
