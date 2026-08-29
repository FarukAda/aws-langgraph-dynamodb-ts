[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSessionChatMessageHistory

# Class: DynamoDBSessionChatMessageHistory

Defined in: history/session-adapter.ts:15

Single-session view over a SessionBackend, implementing LangChain's
`BaseListChatMessageHistory` so it can drive `RunnableWithMessageHistory`.

## Extends

- `BaseListChatMessageHistory`

## Constructors

### Constructor

> **new DynamoDBSessionChatMessageHistory**(`backend`, `sessionId`): `DynamoDBSessionChatMessageHistory`

Defined in: history/session-adapter.ts:18

#### Parameters

##### backend

`SessionBackend`

##### sessionId

`string`

#### Returns

`DynamoDBSessionChatMessageHistory`

#### Overrides

`BaseListChatMessageHistory.constructor`

## Properties

### lc\_namespace

> **lc\_namespace**: `string`[]

Defined in: history/session-adapter.ts:16

A path to the module that contains the class, eg. ["langchain", "llms"]
Usually should be the same as the entrypoint the class is exported from.

#### Overrides

`BaseListChatMessageHistory.lc_namespace`

## Methods

### addMessage()

> **addMessage**(`message`): `Promise`\<`void`\>

Defined in: history/session-adapter.ts:29

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

Defined in: history/session-adapter.ts:33

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

Defined in: history/session-adapter.ts:37

Remove all messages from the store.

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseListChatMessageHistory.clear`

***

### getMessages()

> **getMessages**(): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: history/session-adapter.ts:25

Returns a list of messages stored in the store.

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

#### Overrides

`BaseListChatMessageHistory.getMessages`
