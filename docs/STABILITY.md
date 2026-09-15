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
| Checkpointer | `CHKPT#<thread_id>` | `META#<ns>#<checkpoint_id>`, `PAYLOAD#<ns>#<checkpoint_id>`, `WRITE#<ns>#<checkpoint_id>#<task>#<idx>#<channel>` | META: `threadId`, `checkpointNs`, `checkpointId`, `metadata`, `v`, optional `parentCheckpointId`, `gsi1pk`, `gsi1sk`, `ttl`; PAYLOAD: `checkpoint`, `v`, optional `ttl`; WRITE: `taskId`, `index`, `channel`, `writeGroup`, `value`, `v`, optional `occurrence`, `ttl` |
| Store | `STORE#<namespace[0]>` | `<namespace[1..]>#<key>` | `namespace`, `key`, `value`, `createdAt`, `updatedAt`, `v`, optional `embeddings`, `embedding`, `gsi1pk`, `gsi1sk`, `rev`, `ttl` |
| Chat history | `HIST#<sessionId>` | `HISTORY#SESSION`, `HISTORY#MSG#<ULID>` | session: `sessionId`, `messageCount`, `createdAt`, `updatedAt`, `v`, optional `title`, `gsi1pk`, `gsi1sk`, `ttl`; message: `sessionId`, `message`, `v`, optional `ttl` |

`v` is the row format version (see §3). `gsi1pk`/`gsi1sk` are the recency-index keys; they are written whether or not a table defines the index, so enabling `indexName` later needs only a backfill. `storedChannels` is a `1.0.0-rc.1` attribute that is no longer written: it is ignored on read and rows that carry it keep their meaning.

Payloads (`checkpoint`, `metadata`, `value`, `message`) are stored as a descriptor `{ schemaVersion: 1, location: 'INLINE' | 'S3', serdeType, compressed, bytes | s3Key }`. Readers ignore unknown descriptor fields, treat a missing `schemaVersion` as `1`, and refuse a higher `schemaVersion` or an unknown `location` with a `ValidationError` rather than guessing. Offloaded objects live at `<keyPrefix><base64url(part)/...>/<sha256 base64url>.bin`: the parts identify the DynamoDB row that points at the object, and the final segment is the content address of the stored bytes. Each object also carries its row's key as S3 user metadata (`dynamodb-pk-b64`, `dynamodb-sk-b64`, both base64url), the backlink AWS recommends for cleaning up orphans. The lifecycle rule id is `langgraph-ttl-<slug of keyPrefix>`. All three are stable for `1.x`. A descriptor always records the full key, so objects written by `1.0.0-rc.1` — whose final segment was a random nonce rather than a hash — are still read and deleted exactly as before; nothing needs migrating.

The `ttl` attribute is Unix epoch seconds. Compression is gzip; `serdeType` names the serializer that produced the bytes and is honoured on read even when the adapter is configured with another one.

## 3. Errors, logs and row versions

Every row this release writes carries `v`, its format version. A reader treats a row without `v` as version 0 and reads it under the rules that applied when it was written; a row whose `v` is higher than the reader understands fails with `FORMAT_UNSUPPORTED` instead of being read as though its unknown attributes did not matter. A minor may raise the version it writes only in a way older `1.x` readers still accept.

`ErrorCode` values are append-only in `1.x`; error class names and the `code` each carries are stable, and `ErrorContext` only gains fields. Error *messages* and log *messages* are not covered: branch on `code`, `name` and the structured fields, never on text.

## 4. Supported runtimes and peers

| Dependency | Supported | Verified by |
| --- | --- | --- |
| Node.js | 22 and 24 | the unit tier on Linux, macOS and Windows |
| TypeScript (consumers) | 5.x and later | the package smoke type-checks the shipped declarations with both the 5.x floor and the newest release |
| `@langchain/langgraph-checkpoint` | `^1.1.5` | the conformance tier against the floor and the latest release, including LangChain's checkpointer validation suite |
| `@langchain/langgraph` | any 1.x release that depends on a supported `@langchain/langgraph-checkpoint` (not a peer of this package; the conformance tier runs the current 1.x) | the compiled-graph conformance tests |
| `@langchain/core` | `^1.2.11` | the differential and history tests |
| AWS SDK for JavaScript v3 (`@aws-sdk/client-dynamodb`, `lib-dynamodb`, optional `client-s3`) | the ranges in `package.json` | every tier |

Raising a floor (dropping a Node major after its end of life, requiring a newer LangChain minor) is a **minor** release and is announced in the CHANGELOG. A peer range is never narrowed in a patch.

## 5. Deprecation

Anything scheduled for removal is marked `@deprecated` in its JSDoc and listed in the CHANGELOG for at least one minor release before the major that removes it. Deprecated members keep working until then.

## 6. Not covered

`saver.getDeltaChannelHistory()` tracks an upstream API that `@langchain/langgraph-checkpoint` marks beta: its signature and return shape follow that contract, so a change there can reach a minor of this package. The `ANCESTOR_EXPIRED` code it raises is covered by §3 like every other code.

The wording of error messages and log lines, the order of rows returned by table scans, the exact request counts in the README's cost table, the layout of `docs/api`, timing characteristics, and the internal module structure.

## 7. Differences from the reference implementations

`MemorySaver` and `InMemoryStore` are the behaviour this package matches. Every
observable difference is listed here; anything not in this table is a defect,
not a choice, and the differential tests are what enforce that.

| # | Difference | Kept because |
| --- | --- | --- |
| V-1 | Write identity is `(taskId, channel, occurrence)` | index positions are unstable across a retry; kept unobservable by read-side dedup |
| V-2 | Namespace prefixes match element-wise | the reference compares the joined string, so `['users']` matches `['userspace']` |
| V-3 | Namespace elements may not contain `#` | the separator is structural in the sort key |
| V-4 | A namespace whose items are all deleted stops being listed | the reference retains an empty namespace with no row behind it |
| V-5 | `search` / `listNamespaces` raise `RESULT_TRUNCATED` past `maxScanItems` | silently truncating a result set is worse than refusing it |
| V-6 | Re-putting with `index: false` clears the stored vector | the reference keeps a stale vector for a changed value |
| V-7 | `batch` returns `undefined` for a put, the reference returns `null` | cosmetic; recorded so it is not mistaken for a bug |
| V-8 | A value JSON refuses (circular, `BigInt`) yields no index text instead of throwing from inside text extraction | the put is refused a moment later by the codec, with a `ValidationError` naming `value` rather than a raw `TypeError` from the embedding step |
| V-9 | Namespaces the collation calls equal are ordered by code unit | the reference leaves that pair to insertion order, which here is DynamoDB's read order, so a page boundary could fall between them differently on two calls |
| V-10 | `put` stores every channel value, never only the ones `newVersions` names | narrowing stored *nothing* when LangGraph forks a checkpoint or writes an empty update, both of which pass an empty `newVersions`. `MemorySaver.put` takes no `newVersions` either, and LangChain's validation suite exempts its own `MemorySaver`, MongoDB and SQLite savers from the delta test on the same grounds; the exemption is keyed on a module-name list, so `test/conformance/validation.conformance.test.ts` applies it by name |

Adding a difference to this table is a **minor** release at most, and only when
the reference itself is the defect; changing one a caller may already rely on is
a **major**.
