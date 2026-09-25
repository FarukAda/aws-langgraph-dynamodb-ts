[**AWS LangGraph DynamoDB TypeScript**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / ListNamespacesOptions

# Interface: ListNamespacesOptions

Defined in: [store/types.ts:71](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L71)

Options [DynamoDBStore.listNamespaces](../classes/DynamoDBStore.md#listnamespaces) accepts: the object
`BaseStore.listNamespaces` declares inline, with the same five optional
fields, named so a caller can type the options it builds. A test pins it
equal to upstream's parameter type.

## Properties

### limit?

> `optional` **limit?**: `number`

Defined in: [store/types.ts:85](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L85)

How many namespaces to return, from 0 to `MAX_PAGE_LIMIT` (10,000);
default 100. `0` returns an empty array without reading the table.

***

### maxDepth?

> `optional` **maxDepth?**: `number`

Defined in: [store/types.ts:80](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L80)

Truncate each namespace to at most this many labels, at least 1; the
namespaces that truncation makes equal are listed once.

***

### offset?

> `optional` **offset?**: `number`

Defined in: [store/types.ts:87](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L87)

How many namespaces to skip first, a non-negative integer; default 0.

***

### prefix?

> `optional` **prefix?**: `string`[]

Defined in: [store/types.ts:73](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L73)

Only namespaces starting with these labels; `'*'` matches any one label.

***

### suffix?

> `optional` **suffix?**: `string`[]

Defined in: [store/types.ts:75](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/main/src/store/types.ts#L75)

Only namespaces ending with these labels; `'*'` matches any one label.
