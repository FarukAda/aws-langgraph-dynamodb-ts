[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / DynamoDBFactory

# Class: DynamoDBFactory

Defined in: [factory/factory.ts:116](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L116)

Convenience constructors for the adapters.

Individual `create*` methods each build their own client; [createAll](#createall)
builds one shared client used by all three and returns a combined `destroy`
that tears everything down once. Each adapter validates the options it ends
up with, so the same mistake is caught the same way however the adapter was
built. The factory checks only what it reads itself before an adapter can:
its own base options, client choice and logger, the keys of `createAll`'s
argument, and that each adapter's options are an object at all.

Every `create*` argument and every `createAll` section is one adapter's
options, and a mistake in one is named the way that adapter's constructor
names it: `options` for a value that is not an object, and the adapter's own
field names (`options.<key>`, `tableName`, …) for anything inside one.

## Constructors

### Constructor

> **new DynamoDBFactory**(`base?`): `DynamoDBFactory`

Defined in: [factory/factory.ts:135](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L135)

Accepts: `base` — the defaults every adapter inherits. Checked here, where
the caller wrote them: an unknown key would otherwise be ignored, and a
`client` next to a `clientConfig` was refused by the first `create*` call
and accepted by `createAll`, for the same base. So is the shape of
`clientConfig`: `createAll` hands its adapters the client built from it,
never the config, so no adapter would see a malformed one. And so is
`logger`, which `createAll` logs its own teardown failures through: a
malformed one threw from inside that teardown, replacing a failed build's
own error with a bare `TypeError`.

Returns: a factory holding those defaults. It opens nothing: every client
is built by the `create*` call that needs one.

Throws: `VALIDATION` naming `options.<key>`, `client`, `clientConfig`,
`logger` or `logger.<method>`. Everything else each adapter validates for
itself, since a per-adapter value may still replace it.

#### Parameters

##### base?

[`FactoryBaseOptions`](../interfaces/FactoryBaseOptions.md) = `{}`

#### Returns

`DynamoDBFactory`

## Methods

### createAll()

> **createAll**\<`O`\>(`options`): [`CreatedAdapters`](../interfaces/CreatedAdapters.md)\<`O`\>

Defined in: [factory/factory.ts:261](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L261)

Build the adapters whose sections are given, all on one shared client.

Accepts: `options` — a section per adapter, laid over the factory's shared
defaults; omitting one, or giving it as `undefined`, skips that adapter,
and `{}` builds none. A key that is not a section name is refused rather
than ignored, so a misspelt one cannot silently build nothing. Each section
is that adapter's options, so one that is not an object, `null` included,
is refused before any client is built.

Returns: the adapters, typed by the sections asked for, and one `destroy`
that releases all of them and the shared client. A client the factory was
given rather than built is never destroyed.

Throws: `VALIDATION` naming `options` for an argument or a section that
is not an object, or `options.<key>` for a key that is not a section name.
Whatever an adapter's constructor throws — after the adapters already
built and the freshly created client have been released, so a failed call
leaks nothing and the constructor's own error is the one that propagates.

Guarantees: one DynamoDB client for all three adapters, and one S3 client
per adapter, each under its own key prefix in the shared bucket. Teardown
is total: one adapter failing to release its resources cannot strand the
others.

#### Type Parameters

##### O

`O` *extends* [`CreateAllOptions`](../interfaces/CreateAllOptions.md)

#### Parameters

##### options

`O`

#### Returns

[`CreatedAdapters`](../interfaces/CreatedAdapters.md)\<`O`\>

***

### createChatMessageHistory()

> **createChatMessageHistory**(`options`): [`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

Defined in: [factory/factory.ts:231](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L231)

A chat history on its own client.

Accepts: as [createSaver](#createsaver), for the history's options.

Returns: the chat history.

Throws: as [createSaver](#createsaver).

#### Parameters

##### options

[`DynamoDBChatMessageHistoryOptions`](../type-aliases/DynamoDBChatMessageHistoryOptions.md)

#### Returns

[`DynamoDBChatMessageHistory`](DynamoDBChatMessageHistory.md)

***

### createSaver()

> **createSaver**(`options`): [`DynamoDBSaver`](DynamoDBSaver.md)

Defined in: [factory/factory.ts:203](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L203)

A saver on its own client.

Accepts: `options` — the saver's own, laid over the factory's defaults. A
per-adapter value wins; see defaultsFor for how a client choice
replaces the factory's as a unit.

Returns: the saver, which owns the client it built and releases it on
`destroy()`.

Throws: `VALIDATION` for any invalid option, naming it as the saver's
constructor does — `options` for a value that is not an object, checked
before the defaults are laid under it: reading `.client` off a `null`
value would throw here, and spreading a string would iterate its
characters instead of refusing it.

#### Parameters

##### options

[`DynamoDBSaverOptions`](../type-aliases/DynamoDBSaverOptions.md)

#### Returns

[`DynamoDBSaver`](DynamoDBSaver.md)

***

### createStore()

> **createStore**(`options`): [`DynamoDBStore`](DynamoDBStore.md)

Defined in: [factory/factory.ts:217](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/factory/factory.ts#L217)

A store on its own client.

Accepts: as [createSaver](#createsaver), for the store's options.

Returns: the store.

Throws: as [createSaver](#createsaver).

#### Parameters

##### options

[`DynamoDBStoreOptions`](../type-aliases/DynamoDBStoreOptions.md)

#### Returns

[`DynamoDBStore`](DynamoDBStore.md)
