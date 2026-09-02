[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSessionChatMessageHistory

# Class: DynamoDBSessionChatMessageHistory

Defined in: [history/session-adapter.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/session-adapter.ts#L20)

Single-session view over a [SessionBackend](../interfaces/SessionBackend.md), implementing LangChain's
`BaseListChatMessageHistory` so it can drive `RunnableWithMessageHistory`.
A `window` bounds what every read hands the chain — `{ limit: 50 }` feeds it
the newest fifty messages instead of the whole session.

## Extends

- `BaseListChatMessageHistory`

## Constructors

### Constructor

> **new DynamoDBSessionChatMessageHistory**(`backend`, `sessionId`, `window?`): `DynamoDBSessionChatMessageHistory`

Defined in: [history/session-adapter.ts:23](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/session-adapter.ts#L23)

#### Parameters

##### backend

[`SessionBackend`](../interfaces/SessionBackend.md)

##### sessionId

`string`

##### window?

[`AdapterWindow`](../type-aliases/AdapterWindow.md)

#### Returns

`DynamoDBSessionChatMessageHistory`

#### Overrides

`BaseListChatMessageHistory.constructor`

## Properties

### lc\_namespace

> **lc\_namespace**: `string`[]

Defined in: [history/session-adapter.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/session-adapter.ts#L21)

A path to the module that contains the class, eg. ["langchain", "llms"]
Usually should be the same as the entrypoint the class is exported from.

#### Overrides

`BaseListChatMessageHistory.lc_namespace`

## Methods

### addMessage()

> **addMessage**(`message`): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:35](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/session-adapter.ts#L35)

Add a message object to the store.

#### Parameters

##### message

`BaseMessage`

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseListChatMessageHistory.addMessage`

***

### addMessages()

> **addMessages**(`messages`): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:39](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/session-adapter.ts#L39)

Add a list of messages.

Implementations should override this method to handle bulk addition of messages
in an efficient manner to avoid unnecessary round-trips to the underlying store.

#### Parameters

##### messages

`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]

A list of BaseMessage objects to store.

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseListChatMessageHistory.addMessages`

***

### clear()

> **clear**(): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:43](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/session-adapter.ts#L43)

Remove all messages from the store.

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseListChatMessageHistory.clear`

***

### getMessages()

> **getMessages**(): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/session-adapter.ts:31](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/3b5f72171f6f425e9907910e2c0cff527aeb82cf/src/history/session-adapter.ts#L31)

Returns a list of messages stored in the store.

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

#### Overrides

`BaseListChatMessageHistory.getMessages`
