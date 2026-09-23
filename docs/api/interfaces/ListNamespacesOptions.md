[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ListNamespacesOptions

# Interface: ListNamespacesOptions

Defined in: [store/types.ts:72](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L72)

Options [DynamoDBStore.listNamespaces](../classes/DynamoDBStore.md#listnamespaces) accepts: the object
`BaseStore.listNamespaces` declares inline, with the same five optional
fields, named so a caller can type the options it builds. A test pins it
equal to upstream's parameter type.

## Properties

### limit?

> `optional` **limit?**: `number`

Defined in: [store/types.ts:86](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L86)

How many namespaces to return, from 0 to `MAX_PAGE_LIMIT` (10,000);
default 100. `0` returns an empty array without reading the table.

***

### maxDepth?

> `optional` **maxDepth?**: `number`

Defined in: [store/types.ts:81](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L81)

Truncate each namespace to at most this many labels, at least 1; the
namespaces that truncation makes equal are listed once.

***

### offset?

> `optional` **offset?**: `number`

Defined in: [store/types.ts:88](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L88)

How many namespaces to skip first, a non-negative integer; default 0.

***

### prefix?

> `optional` **prefix?**: `string`[]

Defined in: [store/types.ts:74](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L74)

Only namespaces starting with these labels; `'*'` matches any one label.

***

### suffix?

> `optional` **suffix?**: `string`[]

Defined in: [store/types.ts:76](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L76)

Only namespaces ending with these labels; `'*'` matches any one label.
