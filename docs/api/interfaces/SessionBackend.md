[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionBackend

# Interface: SessionBackend

Defined in: [history/session-adapter.ts:8](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L8)

The session-scoped operations a single-session adapter delegates to.

## Methods

### addMessages()

> **addMessages**(`sessionId`, `messages`): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:10](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L10)

#### Parameters

##### sessionId

`string`

##### messages

`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]

#### Returns

`Promise`\<`void`\>

***

### clear()

> **clear**(`sessionId`): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:11](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L11)

#### Parameters

##### sessionId

`string`

#### Returns

`Promise`\<`void`\>

***

### getMessages()

> **getMessages**(`sessionId`, `window?`): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/session-adapter.ts:9](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L9)

#### Parameters

##### sessionId

`string`

##### window?

[`AdapterWindow`](../type-aliases/AdapterWindow.md)

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>
