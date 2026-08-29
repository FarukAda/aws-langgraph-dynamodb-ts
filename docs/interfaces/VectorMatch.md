[**AWS LangGraph DynamoDB TypeScript v0.8.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / VectorMatch

# Interface: VectorMatch

Defined in: [store/vector-backend.ts:2](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/vector-backend.ts#L2)

A vector-similarity match returned by an external [VectorBackend](VectorBackend.md).

## Properties

### key

> **key**: `string`

Defined in: [store/vector-backend.ts:4](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/vector-backend.ts#L4)

***

### namespace

> **namespace**: `string`[]

Defined in: [store/vector-backend.ts:3](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/vector-backend.ts#L3)

***

### score

> **score**: `number`

Defined in: [store/vector-backend.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/5a137c4668c089acbdd8dcb66b61b636923c4718/src/store/vector-backend.ts#L17)

Relevance, where **higher means a better match** — the same direction as
upstream `SearchItem.score`, which this value is forwarded to verbatim.

A backend whose native output is a *distance* (S3 Vectors, FAISS L2,
pgvector's `<->`) must convert before returning: a distance ranks the
other way, so forwarding one unconverted yields results that are ordered
correctly but scored backwards, which silently breaks any caller that
thresholds or displays the number. This package cannot tell the two apart
and never reorders what a backend returns; it only warns when the scores
it sees are not non-increasing.
