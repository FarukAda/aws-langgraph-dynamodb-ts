[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / MultiSessionHistory

# Interface: MultiSessionHistory

Defined in: [history/session-adapter.ts:34](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L34)

A history holding many sessions, addressed by session id: what a
single-session adapter wraps. `DynamoDBChatMessageHistory` is one.

## Methods

### addMessages()

> **addMessages**(`sessionId`, `messages`): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:36](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L36)

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

Defined in: [history/session-adapter.ts:37](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L37)

#### Parameters

##### sessionId

`string`

#### Returns

`Promise`\<`void`\>

***

### getMessages()

> **getMessages**(`sessionId`, `window?`): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/session-adapter.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L35)

#### Parameters

##### sessionId

`string`

##### window?

[`AdapterWindow`](../type-aliases/AdapterWindow.md)

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>
