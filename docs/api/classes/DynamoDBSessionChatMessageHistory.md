[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSessionChatMessageHistory

# Class: DynamoDBSessionChatMessageHistory

Defined in: [history/session-adapter.ts:20](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L20)

Single-session view over a [SessionBackend](../interfaces/SessionBackend.md), implementing LangChain's
`BaseListChatMessageHistory` so it can drive `RunnableWithMessageHistory`.
A `window` bounds what every read hands the chain — `{ limit: 50 }` feeds it
the newest fifty messages instead of the whole session.

## Extends

- `BaseListChatMessageHistory`

## Constructors

### Constructor

> **new DynamoDBSessionChatMessageHistory**(`backend`, `sessionId`, `window?`): `DynamoDBSessionChatMessageHistory`

Defined in: [history/session-adapter.ts:33](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L33)

Accepts: `backend` — the multi-session adapter this view delegates to.
`sessionId` — the one session it is bound to. `window` — bounds every read
it performs.

Returns: the view. Normally built through
`DynamoDBChatMessageHistory.forSession`, which is the supported route.

Throws: nothing; it opens nothing and reads nothing.

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

Defined in: [history/session-adapter.ts:21](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L21)

A path to the module that contains the class, eg. ["langchain", "llms"]
Usually should be the same as the entrypoint the class is exported from.

#### Overrides

`BaseListChatMessageHistory.lc_namespace`

## Methods

### addMessage()

> **addMessage**(`message`): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:66](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L66)

Append one message to this session.

Accepts: `message` — a LangChain message.

Returns: nothing.

Throws: as [addMessages](#addmessages).

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

Defined in: [history/session-adapter.ts:82](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L82)

Append messages to this session.

Accepts: `messages` — LangChain messages; an empty list writes nothing.

Returns: nothing, and only once every message has landed.

Throws: whatever the backend's `addMessages` throws.

Guarantees: the window bounds what is *read*, never what is written — the
session keeps every message appended to it.

#### Parameters

##### messages

`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseListChatMessageHistory.addMessages`

***

### clear()

> **clear**(): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:99](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L99)

Delete this session's messages, metadata and offloaded objects.

Accepts: nothing.

Returns: nothing. Clearing a session that does not exist is not an error.

Throws: whatever the backend's `clear` throws.

Guarantees: the whole session goes, not the window.
`BaseListChatMessageHistory` declares `clear()`, and a chain that calls it
is asking for exactly that.

#### Returns

`Promise`\<`void`\>

#### Overrides

`BaseListChatMessageHistory.clear`

***

### getMessages()

> **getMessages**(): `Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

Defined in: [history/session-adapter.ts:53](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L53)

This session's messages in chronological order.

Accepts: nothing — the session and the window are fixed at construction,
which is what `BaseListChatMessageHistory` requires.

Returns: the messages, bounded by the adapter's window. LangChain calls
this on every chain invocation, so the window is what keeps a long session
from growing the prompt without limit.

Throws: whatever the backend's `getMessages` throws.

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

#### Overrides

`BaseListChatMessageHistory.getMessages`
