[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CreatedAdapters

# Interface: CreatedAdapters\<O\>

Defined in: [factory/types.ts:67](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L67)

The adapters `createAll` built, typed by the sections it was given: an
omitted section is `undefined`. The default names the all-three result.

## Type Parameters

### O

`O` *extends* [`CreateAllOptions`](CreateAllOptions.md) = `Required`\<[`CreateAllOptions`](CreateAllOptions.md)\>

## Properties

### destroy

> **destroy**: () => `void`

Defined in: [factory/types.ts:72](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L72)

Tear down every built adapter and the shared client, once.

#### Returns

`void`

***

### history

> **history**: `O` *extends* `object` ? [`DynamoDBChatMessageHistory`](../classes/DynamoDBChatMessageHistory.md) : `undefined`

Defined in: [factory/types.ts:70](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L70)

***

### saver

> **saver**: `O` *extends* `object` ? [`DynamoDBSaver`](../classes/DynamoDBSaver.md) : `undefined`

Defined in: [factory/types.ts:68](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L68)

***

### store

> **store**: `O` *extends* `object` ? [`DynamoDBStore`](../classes/DynamoDBStore.md) : `undefined`

Defined in: [factory/types.ts:69](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/types.ts#L69)
