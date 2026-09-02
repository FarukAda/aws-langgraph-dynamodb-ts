# Stability and compatibility policy (1.x)

This package follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). For a persistence adapter the storage layout is as much a contract as the TypeScript API, so this document states exactly what a `1.x` release promises to keep, what a minor may add, and what only a `2.0` may change.

## 1. The public API

The public API is everything exported from the package entry point (`src/index.ts`, published as `dist/index.js` / `dist/index.d.ts`): the four classes `DynamoDBSaver`, `DynamoDBStore`, `DynamoDBChatMessageHistory`, `DynamoDBSessionChatMessageHistory` and `DynamoDBFactory`; the error model (`DynamoDBLangGraphError`, `ErrorCode`, the typed error classes, `UpstreamError`, `isDynamoDBLangGraphError`); the logging helpers (`redactLogger`, `redactSecrets`); and every exported type. A test (`test/types/public-surface.test.ts`) enumerates the set and pins the adapter method signatures.

- A **minor** release may add exports, add optional options and parameters, add optional fields to returned objects, and widen accepted inputs.
- A **patch** release changes behaviour only to fix a defect against the documented behaviour.
- Removing or renaming an export, making an option required, narrowing an input, or changing a return type requires a **major** release, preceded by a deprecation (below).
- Deep imports (`@farukada/aws-langgraph-dynamodb-ts/dist/...`) are blocked by the `exports` map and are not part of the API. The `createClient` / `createS3Client` seams are test hooks stripped from the shipped declarations and are not supported.

## 2. The on-disk layout

Every `1.x` release reads every row a `1.0` release wrote. New attributes may be added in a minor; they are optional and a row without them keeps its `1.0` meaning. The key formats, the required attributes and the payload descriptor below change only in a major release, with a migration note.

| Adapter | Partition key | Sort keys | Attributes |
| --- | --- | --- | --- |
| Checkpointer | `CHKPT#<thread_id>` | `META#<ns>#<checkpoint_id>`, `PAYLOAD#<ns>#<checkpoint_id>`, `WRITE#<ns>#<checkpoint_id>#<task>#<idx>#<channel>` | META: `threadId`, `checkpointNs`, `checkpointId`, `metadata`, optional `parentCheckpointId`, `storedChannels`, `ttl`; PAYLOAD: `checkpoint`, optional `ttl`; WRITE: `taskId`, `index`, `channel`, `writeGroup`, `value`, optional `occurrence`, `ttl` |
| Store | `STORE#<namespace[0]>` | `<namespace[1..]>#<key>` | `namespace`, `key`, `value`, `createdAt`, `updatedAt`, optional `embedding`, `rev`, `ttl` |
| Chat history | `HIST#<sessionId>` | `HISTORY#SESSION`, `HISTORY#MSG#<ULID>` | session: `sessionId`, `messageCount`, `createdAt`, `updatedAt`, optional `title`, `ttl`; message: `sessionId`, `message`, optional `ttl` |

Payloads (`checkpoint`, `metadata`, `value`, `message`) are stored as a descriptor `{ schemaVersion: 1, location: 'INLINE' | 'S3', serdeType, compressed, bytes | s3Key }`. Readers ignore unknown descriptor fields, treat a missing `schemaVersion` as `1`, and refuse a higher `schemaVersion` or an unknown `location` with a `ValidationError` rather than guessing. Offloaded objects live at `<keyPrefix><base64url(part)/...>.bin` and the lifecycle rule id is `langgraph-ttl-<slug of keyPrefix>`; both are stable for `1.x`.

The `ttl` attribute is Unix epoch seconds. Compression is gzip; `serdeType` names the serializer that produced the bytes and is honoured on read even when the adapter is configured with another one.

## 3. Errors and logs

`ErrorCode` values are append-only in `1.x`; error class names and the `code` each carries are stable, and `ErrorContext` only gains fields. Error *messages* and log *messages* are not covered: branch on `code`, `name` and the structured fields, never on text.

## 4. Supported runtimes and peers

| Dependency | Supported | Verified by |
| --- | --- | --- |
| Node.js | 22 and 24 | the unit tier on Linux, macOS and Windows |
| TypeScript (consumers) | 5.x and later | the package smoke type-checks the shipped declarations |
| `@langchain/langgraph-checkpoint` | `^1.1.5` | the conformance tier against the floor and the latest release, including LangChain's checkpointer validation suite |
| `@langchain/langgraph` | `^1.3.2` | the compiled-graph conformance tests |
| `@langchain/core` | `^1.2.9` | the differential and history tests |
| AWS SDK for JavaScript v3 (`@aws-sdk/client-dynamodb`, `lib-dynamodb`, optional `client-s3`) | the ranges in `package.json` | every tier |

Raising a floor (dropping a Node major after its end of life, requiring a newer LangChain minor) is a **minor** release and is announced in the CHANGELOG. A peer range is never narrowed in a patch.

## 5. Deprecation

Anything scheduled for removal is marked `@deprecated` in its JSDoc and listed in the CHANGELOG for at least one minor release before the major that removes it. Deprecated members keep working until then.

## 6. Not covered

The wording of error messages and log lines, the order of rows returned by table scans, the exact request counts in the README's cost table, the layout of `docs/api`, timing characteristics, and the internal module structure.
