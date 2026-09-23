[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / SessionBackend

# Interface: SessionBackend

Defined in: [history/session-adapter.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L21)

The session-scoped operations a single-session adapter delegates to.

## Methods

### addMessages()

> **addMessages**(`sessionId`, `messages`): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L23)

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

Defined in: [history/session-adapter.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L24)

#### Parameters

##### sessionId

`string`

#### Returns

`Promise`\<`void`\>

***

### getMessages()

> **getMessages**(`sessionId`, `window?`): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/session-adapter.ts:22](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L22)

#### Parameters

##### sessionId

`string`

##### window?

[`AdapterWindow`](../type-aliases/AdapterWindow.md)

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>
