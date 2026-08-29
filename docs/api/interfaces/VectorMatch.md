[**AWS LangGraph DynamoDB TypeScript v0.9.0**](../README.md)

***

[AWS LangGraph DynamoDB TypeScript](../README.md) / VectorMatch

# Interface: VectorMatch

Defined in: [store/vector-backend.ts:2](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/store/vector-backend.ts#L2)

A vector-similarity match returned by an external [VectorBackend](VectorBackend.md).

## Properties

### key

> **key**: `string`

Defined in: [store/vector-backend.ts:4](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/store/vector-backend.ts#L4)

***

### namespace

> **namespace**: `string`[]

Defined in: [store/vector-backend.ts:3](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/store/vector-backend.ts#L3)

***

### score

> **score**: `number`

Defined in: [store/vector-backend.ts:17](https://github.com/FarukAda/aws-langgraph-dynamodb-ts/blob/c3f018f37290d04fc34b7157d4ff279f0567c7f1/src/store/vector-backend.ts#L17)

Relevance, where **higher means a better match** — the same direction as
upstream `SearchItem.score`, which this value is forwarded to verbatim.

A backend whose native output is a *distance* (S3 Vectors, FAISS L2,
pgvector's `<->`) has two options: convert before returning, or declare
`vectorScoreDirection: 'distance'` on the store, which negates and
re-sorts for you. Forwarding an unconverted distance without declaring it
yields results ordered correctly but scored backwards, which silently
breaks any caller that thresholds or displays the number; that case is
warned about but never reordered.
