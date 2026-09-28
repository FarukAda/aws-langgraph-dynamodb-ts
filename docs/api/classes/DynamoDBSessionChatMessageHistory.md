[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBSessionChatMessageHistory

# Class: DynamoDBSessionChatMessageHistory

Defined in: [history/session-adapter.ts:49](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L49)

Single-session view over a [MultiSessionHistory](../interfaces/MultiSessionHistory.md), implementing LangChain's
`BaseListChatMessageHistory` so it can drive `RunnableWithMessageHistory`.
A `window` bounds what every read hands the chain — `{ limit: 50 }` feeds it
the newest fifty messages instead of the whole session.

## Extends

- `BaseListChatMessageHistory`

## Constructors

### Constructor

> **new DynamoDBSessionChatMessageHistory**(`backend`, `sessionId`, `window?`): `DynamoDBSessionChatMessageHistory`

Defined in: [history/session-adapter.ts:75](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L75)

Accepts: `backend` — the multi-session adapter this view delegates to,
checked structurally for [MultiSessionHistory](../interfaces/MultiSessionHistory.md)'s own members. `sessionId`
— the one session it is bound to, validated the same way every other
adapter method validates a session id. `window` — bounds every read it
performs; when given, only the `limit` key `AdapterWindow` declares, an
integer from 1 to the package's page ceiling. `0` is refused: this window
is what `RunnableWithMessageHistory` reads on every invocation, and an
empty one is indistinguishable from a conversation that never happened.

Returns: the view. Normally built through
`DynamoDBChatMessageHistory.forSession`, which is the supported route.
The adapter keeps the window it parsed, not the caller's object, so
changing that object afterwards changes nothing.

Throws: `VALIDATION` naming `backend`, `backend.<member>` for the first
missing method, `sessionId`, `window` for a window that is not an object,
`window.<key>` for a key `AdapterWindow` does not declare, or `limit`. Checking here reports a caller's mistake at
construction instead of rebranding it as an upstream failure on first use.

#### Parameters

##### backend

[`MultiSessionHistory`](../interfaces/MultiSessionHistory.md)

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

Defined in: [history/session-adapter.ts:50](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L50)

A path to the module that contains the class, eg. ["langchain", "llms"]
Usually should be the same as the entrypoint the class is exported from.

#### Overrides

`BaseListChatMessageHistory.lc_namespace`

## Methods

### addMessage()

> **addMessage**(`message`): `Promise`\<`void`\>

Defined in: [history/session-adapter.ts:116](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L116)

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

Defined in: [history/session-adapter.ts:136](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L136)

Append messages to this session.

Accepts: `messages` — LangChain messages; an empty list writes nothing.

Returns: nothing, and only once every message has landed.

Throws: whatever the backend's `addMessages` throws, wrapped with
the code the classifier assigns unless it is already one of this library's
own errors.

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

Defined in: [history/session-adapter.ts:156](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L156)

Delete this session's messages, metadata and offloaded objects.

Accepts: nothing.

Returns: nothing. Clearing a session that does not exist is not an error.

Throws: whatever the backend's `clear` throws, wrapped with the code the
classifier assigns unless it is already one of this library's own errors.

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

Defined in: [history/session-adapter.ts:101](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/history/session-adapter.ts#L101)

This session's messages in chronological order.

Accepts: nothing — the session and the window are fixed at construction,
which is what `BaseListChatMessageHistory` requires.

Returns: the messages, bounded by the adapter's window. LangChain calls
this on every chain invocation, so the window is what keeps a long session
from growing the prompt without limit.

Throws: whatever the backend's `getMessages` throws, wrapped with
the code the classifier assigns unless it is already one of this library's
own errors.

#### Returns

`Promise`\<`BaseMessage`\<`MessageStructure`\<`MessageToolSet`\>, `MessageType`\>[]\>

#### Overrides

`BaseListChatMessageHistory.getMessages`
