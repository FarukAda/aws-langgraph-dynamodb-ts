[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / MultiSessionHistory

# Interface: MultiSessionHistory

Defined in: [history/session-adapter.ts:24](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L24)

A history holding many sessions, addressed by session id: what a
single-session adapter wraps. `DynamoDBChatMessageHistory` is one.

## Methods

### addMessages()

> **addMessages**(`sessionId`, `messages`): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:26](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L26)

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

Defined in: [history/session-adapter.ts:27](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L27)

#### Parameters

##### sessionId

`string`

#### Returns

`Promise`\<`void`\>

***

### getMessages()

> **getMessages**(`sessionId`, `window?`): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/session-adapter.ts:25](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L25)

#### Parameters

##### sessionId

`string`

##### window?

[`AdapterWindow`](../type-aliases/AdapterWindow.md)

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>
