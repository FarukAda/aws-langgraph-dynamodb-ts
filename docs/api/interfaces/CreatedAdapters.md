[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / CreatedAdapters

# Interface: CreatedAdapters\<O\>

Defined in: [factory/types.ts:56](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/factory/types.ts#L56)

The adapters `createAll` built, typed by the sections it was given: an
omitted section is `undefined`. The default names the all-three result.

## Type Parameters

### O

`O` *extends* [`CreateAllOptions`](CreateAllOptions.md) = `Required`\<[`CreateAllOptions`](CreateAllOptions.md)\>

## Properties

### destroy

> **destroy**: () => `void`

Defined in: [factory/types.ts:61](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/factory/types.ts#L61)

Tear down every built adapter and the shared client, once.

#### Returns

`void`

***

### history

> **history**: `O` *extends* `object` ? [`DynamoDBChatMessageHistory`](../classes/DynamoDBChatMessageHistory.md) : `undefined`

Defined in: [factory/types.ts:59](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/factory/types.ts#L59)

***

### saver

> **saver**: `O` *extends* `object` ? [`DynamoDBSaver`](../classes/DynamoDBSaver.md) : `undefined`

Defined in: [factory/types.ts:57](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/factory/types.ts#L57)

***

### store

> **store**: `O` *extends* `object` ? [`DynamoDBStore`](../classes/DynamoDBStore.md) : `undefined`

Defined in: [factory/types.ts:58](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/factory/types.ts#L58)
