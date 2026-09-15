# Design — @farukada/aws-langgraph-dynamodb-ts 1.0

The design this package is built to. Binding: code that disagrees with it is a
defect, and a change here precedes a change there.

Every claim about the code as it stands today carries a `file:line`. Every
design choice that has a published industry standard follows it and cites it
(§17); nothing here rests on preference.

---

## 1. Scope

Three adapters over one DynamoDB table, optionally offloading large payloads to
S3.

| Adapter | Implements |
|---|---|
| `DynamoDBSaver` | `BaseCheckpointSaver` |
| `DynamoDBStore` | `BaseStore` |
| `DynamoDBChatMessageHistory` (+ `DynamoDBSessionChatMessageHistory`) | `BaseListChatMessageHistory` |

**Non-goals.** Not an ORM. Not a vector database — vectors go to an injected
`VectorBackend`. No cross-region coordination beyond DynamoDB global tables.

**Deployment targets.** Long-lived Node processes and Lambda. Lambda imposes
two rules the design must respect: clients are reused across invocations
(`client` is injectable, `src/shared/options.ts:19`), and nothing may depend on
work continuing after the response — so no background sweepers.

---

## 2. Access patterns — measured

Every DynamoDB call site in `src/` (28 in total): 11 `GetItem`, 6 `PutItem`,
4 `TransactWriteItems`, 2 `UpdateItem`, 2 `Query` (both inside the shared
paginators), 1 `Scan`, 1 `DeleteItem`, 1 `BatchWriteItem`.

### 2.1 What each pattern costs today

| # | Pattern | Served by | Today |
|---|---|---|---|
| A1 | Newest checkpoint of (thread, ns) | Query desc, limit 1 | `fetch.ts:53` |
| A2 | Checkpoint by id | GetItem | `fetch.ts:45` |
| A3 | Checkpoints of (thread, ns), bounded by `before` | Query `BETWEEN` | `list-scope.ts:88` |
| A4 | Checkpoints of a thread, all namespaces | Query `begins_with META#` | `list-scope.ts:85` |
| A5 | Checkpoints across all threads | **Scan** | `list.ts:83` |
| A6 | Payload of a checkpoint | GetItem | `fetch.ts` |
| A7 | Pending writes of a checkpoint | Query prefix | `fetch.ts:121` |
| A8 | Every row of a thread (delete) | Query partition + BatchWrite | `delete-thread.ts:34` |
| A9 | Store item by (namespace, key) | GetItem | `store/actions/get.ts` |
| A10 | Store items under a non-empty prefix | Query `begins_with` | `candidates.ts:41` |
| A11 | Store items, empty prefix | **Scan** — no index serves a namespace prefix | `candidates.ts:48` |
| A12 | Namespaces, empty prefix | **Scan** | `list-namespaces.ts:24` |
| A13 | Messages of a session, windowed | Query range | `message-window.ts:33` |
| A14 | Sessions, most recent first | **Scan** | `list-sessions.ts:21` |
| A15 | Session metadata | GetItem | `ttl-anchor.ts` |
| A16 | Append messages + count | TransactWriteItems | `message-transaction.ts` |

### 2.2 The two findings that drive the design

**Four access patterns are full-table Scans** (A5, A11, A12, A14). A14 is the
worst and is not an administrative path — it is the session list of a chat
application. As written (`list-sessions.ts:21-54`) it scans the whole table with
a `FilterExpression`, which consumes read capacity for every row *evaluated*, not
every row returned; then it collects every session into an array and sorts in
memory; and `listSessions` returns `SessionMetadata[]` with no cursor, so the
caller cannot page. At 100 000 sessions on a shared table this reads the entire
table on every call.

**Six of the eleven `GetItem` sites exist only for the failure model**, not to
serve data: `store/write-verify.ts` (×2), `store/read-existing.ts`,
`checkpointer/special-write-verify.ts`, `checkpointer/checkpoint-write-verify.ts`,
`history/append-saga.ts`. A seventh, `stored-channels.ts:63`, is the
carry-forward parent read. More than half of this package's point reads are the
cost of not being able to tell "committed" from "not committed".

Both findings have the same shape: the design pays for something structurally
that a different structure would not need.

---

## 3. Data model

One table; three adapters with disjoint key spaces. Every partition key starts
with an adapter tag whose first character differs — `CHKPT#`, `STORE#`, `SESS#`
— so no composed key from one adapter can equal another's
(`checkpointer/internal/keys.ts:38-46`).

### 3.1 On every row

| Attribute | Type | Meaning |
|---|---|---|
| `PK`, `SK` | S | keys |
| `v` | N | **row format version** |
| `ttl` | N | epoch seconds, only when a TTL is configured |
| `gsi1pk`, `gsi1sk` | S | only on indexed row kinds (§4) |

`v` replaces today's implicit versioning, where "written by an older version" is
inferred from a missing attribute — `storedChannels` (`types.ts:36`), `rev`
(`overwrite-swap.ts`), `occurrence` and `writeGroup` (`types.ts:56`). That
inference is unreadable by a maintainer and has already produced one ordering
defect (`item-reader.ts:108-118`, where an absent `writeGroup` cannot be told
from a present-but-undefined one).

**Writer rule.** A writer that finds `v` higher than it supports fails with
`FORMAT_UNSUPPORTED` rather than overwriting. **Reader rule.** Accept `v <=
SUPPORTED`; a missing `v` reads as `v = 0` under the pre-1.0 rules.

### 3.2 Checkpointer

| Row | PK | SK |
|---|---|---|
| META | `CHKPT#<thread>` | `META#<ns>#<id>` |
| PAYLOAD (only when not inline) | `CHKPT#<thread>` | `PAYLOAD#<ns>#<id>` |
| WRITE | `CHKPT#<thread>` | `WRITE#<ns>#<id>#<task>#<idx10>#<channel>` |

META carries the structural ids, `parentCheckpointId?`, the `metadata`
descriptor, and — new — the `checkpoint` descriptor when the encoded checkpoint
fits inline. `idx10` is the write index offset by 8 and zero-padded to ten
digits, so the four negative slots of `WRITES_IDX_MAP`
(`__error__ -1 … __resume__ -4`, verified against
`@langchain/langgraph-checkpoint@1.1.5`) sort below positional writes.

`storedChannels` is removed; every put stores every channel value it carries.

**Inline budget.** A META row must stay under `MAX_INLINE_PAYLOAD_BYTES`
(392 KiB, `constants.ts:40`) *including* metadata, structural attributes and the
GSI1 attributes. The inline threshold is therefore computed against the assembled
row, not against the checkpoint alone.

### 3.3 Store

| Row | PK | SK |
|---|---|---|
| ITEM | `STORE#<namespace[0..d)>` | `<namespace[d..]>#<key>` |

`d` is `partitionDepth`, and it **defaults to 1** — today's layout
(`store/internal/keys.ts:13`).

The trade is real and cannot be designed away. Raising `d` distributes writes:
`["memories", userId]` at `d = 2` gives one partition per user instead of one
for every user. But a search whose prefix names fewer than `d` elements then
spans partitions, and **no index can serve it cheaply**: GSI1 is keyed for
recency (`<timestamp>#<id>`), so a namespace prefix is not expressible as a key
condition there either — filtering the index costs what scanning the table
costs.

So `partitionDepth` is an opt-in for workloads whose searches always name at
least `d` elements. For everyone else the hot-partition guidance stands where it
always was: put a high-cardinality element first, so the partition key is the
tenant or user rather than a constant like `"memories"`.

### 3.4 History

| Row | PK | SK |
|---|---|---|
| SESSION | `SESS#<session>` | `SESSION` |
| MESSAGE | `SESS#<session>` | `MSG#<ulid>` |

---

## 4. GSI1 — the index that removes the Scans

| | Attribute | Value |
|---|---|---|
| PK | `gsi1pk` | `<tag>#<shard>` — `shard = hash(id) mod N`, `N` = `indexShards`, default 8 |
| SK | `gsi1sk` | `<ISO-8601 timestamp>#<id>` |
| Projection | | `INCLUDE` — only the attributes each listing renders |

Written on: checkpointer META rows, store ITEM rows, history SESSION rows. Not
on PAYLOAD, WRITE or MESSAGE rows, which are never listed across partitions.

- **A14** becomes `N` parallel Queries in `gsi1sk` order, merged by timestamp —
  natively paged, no in-memory sort, no Scan.
- **A5, A11, A12** become the same shape, bounded and pageable.

**Sharding is required, not optional.** Without it `gsi1pk` is one value per
adapter and the index is a single hot partition — worse than the Scan it
replaces. `N` is fixed at table creation; changing it requires a backfill.

**Price, stated honestly.** One extra write unit per indexed row (an `INCLUDE`
projection is a second write), plus the index's storage. It is paid on every
checkpoint put and every store put — the hot paths — to make three listing paths
bounded. It is paid on all three indexed row kinds, including checkpointer META
(D-1): a library cannot decide on a caller's behalf that their access pattern is
rare enough to deserve a Scan.

**Public API consequence.** `listSessions` gains a cursor:
`listSessions({ limit, cursor }) → { sessions, nextCursor }`. The current
signature (`chat-message-history.ts:89`) returns an unbounded array and cannot
express paging. This is a breaking change and belongs in 1.0, not after it.

---

## 5. Payload storage

One mechanism, used by all three adapters.

**The key.** An offloaded object's key is

```
<keyPrefix><scope>/<row>/<sha256(bytes)>.bin
```

Two things are structural in it. `<scope>/<row>` is the identity of the
DynamoDB row that points at the object — thread, namespace and checkpoint id
for a checkpoint; namespace and key for a store item; session and message id for
a message — each segment base64url-encoded as today (`s3/config.ts:47`). The
final segment is the SHA-256 of the bytes actually stored, after serialization
and compression.

**What the hash replaces.** Today every upload appends a per-call random nonce
(`put-writes.ts:24`, `item-writer.ts`, `store/actions/put.ts:132`) so that a
retry never lands on the key an earlier attempt used. That makes every attempt a
new object, which is why a failed write has to be followed by a cleanup read and
why two writers racing for one row need a compare-and-swap to agree on which
object may be deleted. A content hash removes the cause: **the same bytes always
produce the same key**, so a retry is a no-op rather than a second object, and
there is no attempt-to-attempt ambiguity left to resolve.

The nonce leaves the *key*; it does not leave the package. Two of its three uses
were never about S3 at all, and they stay: `writeGroup` on a pending-write row,
which is how `dropSupersededWrites` tells one `putWrites` call's rows from
another's, and `rev` on a store item, which is the token a concurrent overwrite
pins with a compare-and-swap. Both identify a *DynamoDB write*. Conflating that
with "which S3 object did my attempt upload" is what made one token carry two
unrelated jobs, and separating them is most of why the S3 bookkeeping can go.

**Not shared between rows.** The row identity sits *above* the hash in the path,
so two rows holding identical bytes get two objects. This is deliberate and it
is what keeps deletion simple: an object belongs to exactly one row, so deleting
that row may delete its object without consulting anything else. The earlier
draft of this design put the hash directly under the scope, making objects
shared; that forces deletion to become a reference count or to be dropped
entirely, and it lets one tenant's retention decision bind another's. Dedup
across rows is not worth either.

**Writes are conditional.** Uploads are sent with `If-None-Match: *`, which
writes the object only if the key does not already exist and otherwise fails
with `412 Precondition Failed` (S3 User Guide, *How to prevent object overwrites
with conditional writes*). Because the key is the hash of the bytes, a 412 means
"these exact bytes are already stored under this exact key" — a success, not an
error, and the upload is skipped. The header needs only `s3:PutObject`, the
permission the package already requires; the `If-Match` variant would also need
`s3:GetObject` and is not used. A `409 Conflict`, which S3 returns when a delete
lands between the check and the write, is retryable exactly like a throttle and
joins the existing S3 retry classifier.

**Deletion stays inline, and gains one rule.** `deleteThread`, `clear` and an
overwriting `put` still delete the objects of the rows they remove, so the
package keeps its current behaviour and does not depend on a lifecycle rule for
correctness.

The rule content addressing forces is this: **a cleanup never releases a key the
surviving row still points at.** Identical bytes produce an identical key, so
the two sides of an overwrite can be one object; releasing "the superseded
object" unconditionally would strand the live row on a missing object.
`releasableS3Keys` applies it at both sites where a superseded descriptor is
deleted, in both directions — the new record survives a committed write, the
previous one survives a confirmed non-commit.

**What this does *not* yet remove.** An earlier draft of this section listed the
compare-and-swap (`special-write-cas.ts`, `overwrite-swap.ts`), `deadUploads`
(`regular-write.ts:21`) and the post-failure verification reads as removed "in
one step". That is not established. Content addressing removes the ambiguity
about *which object an attempt uploaded*; it says nothing about *which row
survives*, which is what those mechanisms actually decide — and which the new
cleanup rule above still needs an answer to. Removing them is a separate
analysis against the same standard, not a consequence of this one.

**The backlink.** Every object carries the DynamoDB `PK` and `SK` of its row in
S3 user metadata. This is the maintenance aid AWS names directly: "You can also
use the object metadata support in Amazon S3 to provide a link back to the
parent item in DynamoDB. Store the primary key value of the item as Amazon S3
metadata of the object" (*Best practices for storing large items and attributes
in DynamoDB*). The same page states the reason it is needed: "DynamoDB doesn't
support transactions that cross Amazon S3 and DynamoDB. Therefore, your
application must deal with any failures, which could include cleaning up
orphaned Amazon S3 objects." An out-of-band sweeper can list the prefix and ask
DynamoDB whether each object's parent row still exists, without parsing keys.

User metadata is capped at 2 KB, summed over the UTF-8 bytes of every key and
value (S3 User Guide, *Working with object metadata*). That cap cannot be
reached here: the same `PK` and `SK` are already encoded into the object key,
which `buildS3Key` caps at 1024 bytes (`constants.ts`, `MAX_S3_KEY_BYTES`), and
base64url expands by a third — so a key that is accepted at all leaves the raw
identifiers under ~770 bytes. A test pins that relationship rather than leaving
it as an assumption.

**What is left unguarded, stated.** An upload that succeeds while its DynamoDB
write then fails permanently leaves one orphaned object. That is inherent —
there is no transaction across the two services — and it is what the backlink
and the lifecycle rule exist for. It is now the *only* orphan path: retries,
races and overwrites no longer create one.

**Caps.** Downloads and decompression are capped at 50 MiB each
(`constants.ts:55,63`) — but **per payload**, while `getTuple`, `search`,
`getMessages` and `store.batch` decode several payloads concurrently. Peak
resident for one call is therefore `readConcurrency × (download + decompressed)`,
which at the defaults is ~800 MiB, not 100 MiB.

That ceiling is now *computable and configurable* rather than implicit:
`readConcurrency` (§21) is a real option, every decode fan-out honours it, and
the limits table and README state the product. It is **not** enforced as a
running byte budget. Doing so needs a declared `size` on every descriptor —
rows written before it would have to reserve the cap and would collapse the
fan-out to one — and two-dimensional accounting over the downloaded and the
decompressed copy. The cost of that is real and the benefit is a tighter
*typical* bound, not a tighter worst case. Recorded here as a decision taken,
not as an omission: a caller who must bound memory sets the three options.

---
## 6. Public API contract

Per method: consistency, idempotency, atomicity, cost. The JSDoc on each method
restates this table and may not diverge from it.

| Method | Consistency | Idempotent | Atomic | Cost (with GSI1) |
|---|---|---|---|---|
| `saver.getTuple` | read-your-writes | yes | — | 2 reads inline, 3 offloaded |
| `saver.list` | eventual | yes | — | 1 query + 1 write-query per tuple |
| `saver.put` | — | yes, by checkpoint id | ordered PAYLOAD→META, not transactional | 1 write inline (+1 index), 2 offloaded |
| `saver.putWrites` | — | first-write-wins per (task, channel, occurrence) | per row | 1 write per value |
| `saver.deleteThread` | — | yes | no | partition query + batched deletes |
| `store.get` | read-your-writes | yes | — | 1 read |
| `store.search` | eventual | yes | — | page, or GSI1 when the prefix is empty |
| `store.put` | — | yes, by content | per row | 1 write + 1 index (+1 CAS read under contention) |
| `store.batch` | — | per operation | no | sum of parts |
| `history.getMessages` | eventual | yes | — | page |
| `history.addMessages` | — | yes, by `ClientRequestToken` | **per chunk**, not per call | 2 units per item |
| `history.listSessions` | eventual | yes | — | `N` index queries, paged |
| `history.clear` | — | yes | no | partition query + batched deletes |

**Stated non-guarantees.** `addMessages` is atomic per chunk; a multi-chunk call
that fails part-way rolls back, and a failed rollback raises
`COMPENSATION_FAILED`. `list` across namespaces orders by namespace, then id
descending. Semantic ranking differs from `InMemoryStore` unless §9/D-7 is taken.

**Changed to match the reference implementations:** `batch` executes reads and
writes in the caller's order (today writes run first, `batch-plan.ts:51`);
`list(..., { limit: 0 })` yields nothing; `list` with a `checkpoint_id` and no
`checkpoint_ns` searches every namespace.

---

## 7. Consistency, concurrency, cancellation

- **Point reads that must see the caller's own writes** use `ConsistentRead`;
  bulk reads do not and say so per method (§6).
- **Concurrent writers to one row**: one compare-and-swap on `rev`, with
  `ReturnValuesOnConditionCheckFailure: ALL_OLD` so the loser re-pins from the
  exception instead of spending a read (`conditional-put.ts:42-76`). Three
  attempts (`OVERWRITE_CAS_MAX_ATTEMPTS`), then an unconditional write and a
  warning.
- **Isolation is per item.** Nothing assumes cross-row isolation except
  `addMessages`, which uses one transaction per chunk.
- **Cancellation contract.** Every long-running method takes an `AbortSignal`.
  A signal that fires rejects with `ABORTED` at the next wait. **Verification and
  cleanup reads that run after a failure are never cancelled** — cancelling them
  would leave a live row pointing at a deleted object. That rule is currently
  applied inconsistently (`special-write-verify.ts:39`,
  `checkpoint-write-verify.ts:69` use the policy without a signal while
  neighbouring calls use `retryFor(context, signal)`); it becomes explicit.
- **Pagination contract.** Every paged read exposes an opaque cursor, valid only
  against the same adapter instance and table, not stable across a format
  version. Generators (`saver.list`) keep their current shape; array-returning
  methods gain `{ items, nextCursor }`.

---

## 8. Failure model

Three outcomes, named identically everywhere:

```
landed | not-landed | unverified
```

One type and one implementation, in `shared/dynamodb/write-verify.ts`. The
concept used to be declared five times under two vocabularies
(`committed`/`not-committed` in the checkpointer's write paths and the history
saga, `landed`/`not-landed` in the store), over three hand-rolled copies of the
same strongly-consistent read. Every site now states only what differs — which
row, which attribute identifies the write, and what that attribute must equal —
through a `RowProbe`; a guard rejection that already carries the row is judged
by the same rule without spending a read (`verdictFor`).

The identity is a string the row carries that this attempt would have written:
a revision attribute (`rev`, `writeGroup`), the S3 key inside a payload
descriptor, or a per-call ULID sort key whose presence at that key is itself
the answer. Existence alone — "is this row gone?", for an ambiguous delete — is
a different question with a different fail-safe direction, so it shares the
read (`readRow`) and keeps its own answer.

`RETRY_EXHAUSTED` is ambiguous by construction: a put can commit and lose its
response. It is resolved by reading the row, never assumed.

| Code | Retryable | Meaning |
|---|---|---|
| `VALIDATION` | no | input outside the accepted domain |
| `FORMAT_UNSUPPORTED` | no | row or payload written by a newer version |
| `CONDITION_CONFLICT` | after re-read | a guarded write lost |
| `RETRY_EXHAUSTED` | yes | budget spent, outcome unknown |
| `BATCH_WRITE_INCOMPLETE` | yes | partial drain |
| `COMPENSATION_FAILED` | no | rollback failed; run the reconcile tool |
| `RESULT_TRUNCATED` | no | narrow the query |
| `COMPRESSION_LIMIT`, `S3_OFFLOAD_FAILED` | no | payload or object problem |
| `ABORTED` | no | the caller's signal fired |
| `UPSTREAM` | depends | an AWS error this package does not classify |

Every message passes the same redaction before reaching an `Error`. Today
`upstream-error.ts:25-30` embeds the cause's text unredacted while `retry.ts:88`
and `errors.ts:130` redact — one path, not two.

---

## 9. Threat model

| Asset | Threat | Control |
|---|---|---|
| Another tenant's rows | A caller supplies an identifier that composes into another tenant's key | Identifiers validated: non-empty, byte-capped, no `#`, no control characters, **well-formed UTF-16**. The last is missing today (`primitives.ts:89`) and is what makes two distinct identifiers encode to one S3 key |
| Another tenant's objects | A row is crafted to point at a foreign object | Scope and row identity are structural in the key, and the content hash is not derivable from anything a writer controls |
| Data at rest | Disk or bucket compromise | DynamoDB encrypts unconditionally; S3 `SSE-KMS` per scope |
| Secrets in logs and errors | An AWS error carrying a credential fragment reaches a log | One redaction path for every message; documented as high-confidence patterns only, not a guarantee |
| Injection into expressions | A caller value reaching an expression string | Every expression is a compile-time literal; all values through `ExpressionAttributeValues`; all names `#`-aliased |
| Prototype pollution | A crafted payload mutating `Object.prototype` | `Object.defineProperty` on writes, `Object.hasOwn` on operator dispatch |
| Denial of service by payload | A payload that explodes on decompression | `maxOutputLength` at the zlib level plus the joint budget of §5 |

---

## 10. Ports

Ten injectable seams, each with a test double: `Clock`, `IdFactory`, `Logger`,
`Metrics`, `Tracer`, `Serde`, `Compressor`, `ObjectStore`, `VectorBackend`,
`DynamoClient`.

`DynamoClient`'s double injects faults — throttling, a lost response, a
half-applied transaction, an S3 failure after commit. The most intricate code in
this package defends against exactly those, and none of them can be produced in a
test today.

---

## 11. Cross-cutting

| Concern | Mechanism |
|---|---|
| **Observability** | `Metrics` port: latency, attempts, throttles, `ConsumedCapacity` from every response, offload ratio, payload sizes, index fan-out width, CAS exhaustion. `Tracer` port: one span per public call, children per AWS call |
| **Logging contract** | Every emitted event has a fixed level, message and **field set**, all three machine-checked against the README's table (`test/static/log-events.test.ts`). An event added without its row fails the build |
| **Documented contract** | Every export — functions, and the reachable members of exported classes — states what it accepts, what it returns and what it throws, machine-checked (`test/static/export-contracts.test.ts`). Stating it is what forces each cell to be decided rather than discovered by a caller |
| **Addressed by a test** | Every exported function is named by at least one test (`test/static/export-tests.test.ts`). Coverage says a line ran; this says a test was written about the function, which is what a contract needs to be more than prose |
| **Backpressure** | Bounded concurrency on every fan-out, not only reads; adaptive delay on throttles; a stop rather than an unbounded loop. Backoff honours the configured policy everywhere, the unprocessed-items drain included |
| **Capacity** | On-demand by default. `partitionDepth` and `indexShards` are the two levers against hot keys. Write amplification documented per operation in §6 |
| **Configuration** | One options schema, validated once at construction, one source of defaults, every limit from §13 |
| **Time** | All timestamps from `Clock`; ULIDs monotonic within a millisecond; TTL `ceil(days)` with a two-day lifecycle margin (`constants.ts:140`) |
| **Serde versioning** | The payload descriptor carries its own `serdeType` and version, independent of the row's `v`: a serializer change must not require a row migration |

---

## 12. Module structure and function shape

```
shared/
  storage/   row + payload writes, the one failure model, the one CAS
  keys/      one key builder, one identifier validation
  codec/     serde, compression, content-addressed objects
  aws/       client construction, retry, pagination, batching
  ports/     the ten interfaces
checkpointer/  row model, list, write identity
store/         namespaces, search, ranking
history/       sessions, chunked append, counting
```

**Function shape.** Parameter objects, never five to nine positional arguments —
24 functions have five or more today, up to nine (`buildCheckpointItems`). No
boolean flags. No type whose two values mean different things to the caller
(`readonly string[] | undefined` where `[]` and `undefined` differ is what
produced the fork data loss).

**Export surface.** Of 216 exported functions, 3 are public, 92 have more than
one consumer, 111 have exactly one, and 9 have none. Exports exist for consumers,
not for tests; tests address module boundaries. Target: ~90.

---

## 13. Limits

| Limit | Value | At the limit |
|---|---|---|
| Identifier | 1024 B, well-formed UTF-16, no `#`, no control chars | `VALIDATION` |
| Key segment | 256 B | `VALIDATION` |
| Sort key | 1024 B | `VALIDATION` |
| Assembled inline row | 392 KiB | offload, or `VALIDATION` without an offloader |
| Offload threshold | 350 KiB | offload |
| Download + decompressed | 50 MiB each, per payload | `S3_OFFLOAD_FAILED` / `COMPRESSION_LIMIT` |
| Memory one call claims decoding payloads | `readConcurrency × (download + decompressed)` | — (configured, not enforced) |
| Items in memory | 10 000 | `RESULT_TRUNCATED` |
| Search candidates | 1000 | `RESULT_TRUNCATED` |
| TTL | 5 years | `VALIDATION` |
| Retry attempts | 5 default, 100 max, 18 floor for message append | `RETRY_EXHAUSTED` |

---

## 14. Verification

| Tier | Proves |
|---|---|
| Contract tests | one case per domain cell, derived from the contract text |
| Property tests | closed domains: identifiers, keys, filters, encodings |
| Differential oracle | random operation sequences against `MemorySaver` / `InMemoryStore`, permanent |
| Fault injection | lost response, throttle, half-applied transaction, S3 failure after commit |
| Integration | DynamoDB Local, plus a real-AWS run on demand before a release |
| Conformance | the upstream validation suite, as a floor |
| Backward compatibility | rows written by 0.9 read correctly by 1.0, as fixtures |

Coverage is a diagnostic, never evidence, and is not cited as such.

---

## 15. Migration and versioning

- **0.9 → 1.0**: every breaking change listed with a written migration section.
- **Row format**: `v` written from 1.0; a missing `v` reads as `v = 0`.
- **Inline checkpoints**: readers accept both shapes from 1.0; no data migration.
- **GSI1**: added by a `backfillGsi1` tool; while the index is absent the code
  falls back to the current paths, so it can be added without downtime.
- **`listSessions` cursor**: breaking, and therefore now.
- **Semver**: the classes, the factory, the options types and `ErrorCode` are the
  public surface; everything else may change in a minor release.

---

## 16. Operations

- **Provisioning**: published CDK/CloudFormation for the table, GSI1, TTL
  attribute, PITR, and the bucket with its lifecycle rule.
- **IAM**: least privilege per feature, machine-checked against the calls the
  code makes (`test/static/iam-actions.test.ts` already does this) — base
  (`GetItem`, `PutItem`, `Query`, `UpdateItem`, `DeleteItem`, `BatchWriteItem`,
  `TransactWriteItems`), `Scan` only while GSI1 is absent, S3 (`GetObject`,
  `PutObject`), lifecycle (`Get/PutBucketLifecycleConfiguration`), and KMS
  (`GenerateDataKey`, `Decrypt`) when `sseKmsKeyId` is configured — never
  `ScheduleKeyDeletion` (D-2).
- **Alarms**: throttles, 4xx rate, consumed capacity per operation,
  retry-exhaustion rate, CAS-exhaustion warnings, offload failure rate.
- **DR**: PITR on the table; S3 objects immutable by content, replication
  optional.
- **Operator tools**: `reconcileMessageCount`, `reconcileVectorIndex`,
  `backfillGsi1`, `ensureS3LifecycleRule` — each documented with its true
  concurrency semantics. `reconcileMessageCount` is **not** concurrency-safe
  today despite what `README.md:298` says.

---

## 17. Decisions, and the standard they follow

None of these is a matter of taste; each has a published answer.

**D-1 · Checkpointer META rows are indexed in GSI1.** AWS: "a `Scan` operation
always scans the entire table or secondary index, then filters out values" and is
to be avoided for production access patterns; secondary indexes exist for
access patterns the table's own key cannot serve
([best practices for querying and scanning](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-query-scan.html)).
A library cannot classify a caller's access pattern as rare on their behalf, so
no read it ships may scan where a key condition could have served it.

That is the achievable form, and it is not the same as "no `Scan` anywhere".
Three cases, decided separately:

- **Reads that name a partition** — every `getTuple`, `getMessages`, a `search`
  under a prefix — are Queries and never scan.
- **Reads that cross partitions** — `saver.list()` without a `thread_id`,
  `history.listSessions()` — are index queries when the table carries GSI1, and
  `Scan` when `indexName` is unset. The index is opt-in because whether the
  table has it is the operator's deployment fact, not something to probe for;
  the `Scan` is the documented behaviour of an unindexed table, not a fallback
  for a window during backfill.
- **Reads that enumerate everything by construction** — `store.search([])` and
  `listNamespaces()` with no concrete prefix root — read every store row because
  that is what they are asked for. No key structure turns "every namespace" into
  a key condition, and GSI1 would read the same rows. They are bounded by
  `maxScanItems` and raise `RESULT_TRUNCATED` rather than truncating silently.

**D-2 · This package uses a KMS key; it never creates or destroys one.** Key
lifecycle is an account-level security boundary and key destruction is
irreversible, so it belongs to the operator, not to a storage library. The
package accepts `sseKmsKeyId` and writes every object under it. Deleting a row
deletes its object (§5), so erasure is ordinarily literal; cryptographic erasure
is the backstop for the one object an interrupted write can orphan and for
objects a lifecycle rule has not yet swept — which is an accepted mechanism: AWS states
that "the right to erasure does not strictly mean that the individual's
information must be deleted" and may be satisfied by permanent irreversible
masking ([Well-Architected Analytics Lens, 3.1.3.2](https://docs.aws.amazon.com/wellarchitected/latest/analytics-lens/best-practice-3.1-privacy-by-design..html)).
No `deleteTenant()` API.

**D-3 · Tenant is a first-class, sharded key component.** AWS's pool model is
explicit that mapping a tenant identifier straight onto a partition key "will
quickly … create partition 'hot spots'", and that the answer is "a secondary
sharding model to associate each tenant with multiple partition keys"
([multi-tenant SaaS storage strategies](https://docs.aws.amazon.com/whitepapers/latest/multi-tenant-saas-storage-strategies/multitenancy-on-dynamodb.html)).
Isolation is then enforced with IAM leading-key conditions, not by convention.

**D-4 (corrected) · `partitionDepth` defaults to 1, and is opt-in.** The
earlier version of this decision said the default should be the full namespace,
on the strength of the partition-key guidance quoted below. That was wrong, and
the error is worth recording rather than editing away: it assumed GSI1 could
serve a prefix search shallower than the partition depth. It cannot. GSI1's sort
key is `<timestamp>#<id>`, so a namespace prefix is not a key condition there;
serving such a search from the index means filtering all of it, which costs what
the table scan costs. Raising the default would therefore have turned every
shallow prefix search into a scan — a silent regression traded for a
distribution win the caller never asked for.

What survives is the warning, not the default: "The more
distinct partition key values that your workload accesses, the more those
requests will be spread across the partitioned space", and a design that does
not distribute "can create 'hot' partitions that result in throttling"
([designing partition keys to distribute your workload](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-partition-key-uniform-load.html)).
`STORE#<namespace[0]>` does concentrate `["memories", userId]` on one partition,
and that is the anti-pattern. The answer is the namespace the caller chooses —
put the high-cardinality element first — plus `partitionDepth` for workloads
that can raise it without losing their prefix searches. It is documented as a
trade, not applied as a default.

**D-5 · Semantic ranking matches `InMemoryStore`.** A drop-in implementation of a
published interface that ranks the same documents differently is a compatibility
defect, not a variant. One embedding per extracted path, scored by best match.

**D-6 · Pre-v4 `pending_sends` migration stays; `deriveTitle` moves behind an
option.** The v<4 checkpoint shape is data this package may itself have written
under an older LangGraph, so reading it is a compatibility obligation, now
guarded by the row's `v`. Deriving a session title from message content is a
product decision, not storage: it stays available but off by default, so the
adapter never invents user-visible content unasked.

**GSI write sharding is itself the documented pattern**, not an invention
([best practices for using secondary indexes](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/bp-indexes.html)).

---

## 18. Decision log

| Decision | Alternative rejected | Why |
|---|---|---|
| Ordered PAYLOAD→META instead of a transaction | keep `TransactWriteItems` | transactional writes cost 2 units per item ([AWS](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html)); ordering gives the same reader guarantee because readers key off META, and a failure leaves a harmless orphan payload |
| Checkpoint inline while small | always a separate PAYLOAD row | removes a round trip from the hottest read; a filtered `list` pays more, but LangGraph calls `getTuple` per super-step and `list` only for history |
| Content-addressed objects under the row's own path | nonce + inline cleanup (today) | the same bytes reach the same key, so a retry is a no-op rather than a second object: no nonce, no compare-and-swap, no post-failure cleanup read. Row identity above the hash keeps objects unshared, so inline deletion survives unchanged |
| One failure type in `shared/dynamodb/write-verify.ts` | keep per-adapter types | the concept was identical in five places under two vocabularies; a fix in one did not reach the others |
| GSI with sharded PK | unsharded GSI | an unsharded index is one hot partition, worse than the Scan |
| Drop `storedChannels` | fix the empty-`newVersions` case | the mechanism costs a consistent parent read per put and buys smaller rows only when a large channel is unchanged |

---

## 19. Module interfaces

§12 gives the shape; this is the contract of each shared module. Adapter
internals are free below these, and may not reimplement them.

### 19.1 `shared/storage`

Content addressing (§5) removes more than the cleanup: it removes the *reason*
for the compare-and-swap. The CAS exists today only to establish which object a
writer superseded, so that exactly one of two racers deletes it
(`conditional-put.ts:47-58`, `overwrite-swap.ts:33-44`). When nothing is deleted
inline, two concurrent overwrites are last-write-wins on the row and both objects
live until the lifecycle expires them. What remains is four functions:

```ts
/** The three outcomes of a write whose response may be lost. */
export type WriteOutcome = 'committed' | 'not-committed' | 'unverified';

export interface RowKey {
  readonly PK: string;
  readonly SK: string;
}

/** Unconditional write. Last write wins. */
export function putRow(ctx: WriteContext, row: Row): Promise<void>;

/** First write wins; reports the row that turned it away, when the service attached one. */
export function putRowIfAbsent(
  ctx: WriteContext,
  row: Row,
): Promise<{ readonly created: boolean; readonly existing?: DocItem }>;

/** One transaction, all-or-nothing, idempotent under the given token. */
export function transactRows(
  ctx: WriteContext,
  items: readonly TransactItem[],
  idempotencyToken: string,
): Promise<void>;

/** Did this write land? The only verification the package keeps. */
export function verifyRow(
  ctx: WriteContext,
  key: RowKey,
  matches: (row: DocItem) => boolean,
): Promise<WriteOutcome>;
```

`verifyRow` has exactly one caller: `history.addMessages`, which must know
whether a chunk committed in order to decide whether to compensate. Every other
write is either idempotent by key (checkpoint id, content hash, ULID) or has no
cleanup to undo.

Replaces `special-write-cas.ts` (143), `special-write-cleanup.ts` (77),
`special-write-verify.ts` (116), `regular-write.ts` (92), `write-guard.ts` (53),
`store/overwrite-swap.ts` (86), `store/write-verify.ts` (84),
`store/persist.ts` (79) and `store/read-existing.ts` (58) — about 790 lines —
with roughly 120.

### 19.2 `shared/keys`

```ts
export type AdapterTag = 'CHKPT' | 'STORE' | 'SESS';

export interface KeySpec {
  readonly tag: AdapterTag;
  readonly tenant?: string;
  readonly segments: readonly string[];
}

export function partitionKey(spec: KeySpec): string;
export function sortKey(segments: readonly string[]): string;
export function sortKeyPrefix(segments: readonly string[]): string;
export function ownsSortKey(tag: AdapterTag, sortKey: string): boolean;
export function indexKeys(
  tag: AdapterTag,
  id: string,
  at: string,
  shards: number,
): { readonly gsi1pk: string; readonly gsi1sk: string };

/** Non-empty, byte-capped, no separator, no control characters, well-formed UTF-16. */
export function validateIdentifier(value: string, field: string, maxBytes: number): void;
```

Replaces three `keys.ts` and three `validation.ts`. The well-formedness rule
lives here and nowhere else, which is what makes the S3 key collision
unrepresentable rather than merely guarded against.

### 19.3 Ports

```ts
interface Clock { now(): Date; nowSeconds(): number }
interface IdFactory { ulid(): string; uuid(): string }
interface Logger { debug(m: string, f?: Fields): void; info: ...; warn: ...; error: ... }
interface Metrics { observe(name: string, value: number, tags?: Tags): void }
interface Tracer { span<T>(name: string, fn: (span: Span) => Promise<T>): Promise<T> }
interface Serde { dumpsTyped(v: unknown): Promise<[string, Uint8Array]>; loadsTyped(t: string, b: Uint8Array): Promise<unknown> }
interface Compressor { compress(b: Uint8Array): Promise<Uint8Array>; decompress(b: Uint8Array, maxOut: number): Promise<Uint8Array> }
interface ObjectStore { put(key: string, bytes: Uint8Array, o: PutOpts): Promise<void>; get(key: string, maxBytes: number): Promise<Uint8Array>; delete(keys: readonly string[]): Promise<void> }
interface VectorBackend { upsert(...): Promise<void>; query(...): Promise<VectorMatch[]>; listKeys?(...): AsyncIterable<VectorRef> }
interface DynamoClient { get; put; query; scan; update; delete; batchWrite; transactWrite }
```

Every port has a test double. `DynamoClient`'s double injects the four failures
the package's hardest code defends against — a lost response, a throttle, a
half-applied transaction, an S3 error after commit — none of which can be
produced in a test today.

---

## 20. Performance contract

A library cannot promise latency it does not own. What it can promise, and what
this design is held to, is a bounded number of round trips and bounded memory per
call.

| Operation | Round trips | Resident memory |
|---|---|---|
| `saver.getTuple` | 2 inline, 3 offloaded | one checkpoint plus its writes |
| `saver.put` | 1 inline, 2 offloaded | one checkpoint |
| `saver.putWrites` (n values) | n, concurrent within the bound | n values |
| `saver.list` (page of n) | 1 + n, concurrent within the bound | the page |
| `store.get` | 1 | one item |
| `store.search` (page of n) | 1 + decode of at most `maxScanItems` | the page |
| `store.search` via `vectorBackend` | 1 backend query per round + one read per match, concurrent within the bound | the page |
| `store.put` | 1, plus the index write | one item |
| `store.reconcileVectorIndex` | 1 query per page + one decode per item (concurrent within the bound) + one backend call per vector | one decode batch, plus every live item's value and vector |
| `history.getMessages` (n) | pages of n | the window |
| `history.addMessages` (n) | ceil(n / 99) transactions | one chunk |
| `history.listSessions` | `indexShards` queries per page | one page |

Two rules follow, and are binding: **no operation issues an unbounded number of
requests**, and **no operation holds an unbounded number of decoded payloads**.
The second is violated today — the 50 MiB download and decompression caps are per
payload while eight are decoded concurrently, so peak resident is about 800 MiB
(§5, §13).

What holds the round-trip column today is the unit suite: 119 assertions count
the commands an adapter issued, and every operation in the table is covered by
at least two of them, so a read that starts fanning out fails a test. What does
*not* exist is a check on the table itself — the numbers above are not derived
from those assertions, and a new operation can be added without one. Peak
resident is not measured anywhere at all: it is derived from the caps in §13
(`readConcurrency × (s3.maxDownloadBytes + compression.maxDecompressedBytes)`),
which bounds it without observing it. A benchmark recording both against
DynamoDB Local, so that a regression in either is a reviewable diff, is still to
be written.

---

## 21. Configuration

One schema, validated once at construction, one source of defaults.

```
tableName              required
client | clientConfig  exactly one
tenant?                enables tenant-scoped keys and IAM leading-key isolation
ttl?                   days or seconds, at most 5 years
retry?                 { maxAttempts, baseDelayMs, maxDelayMs } — honoured everywhere
compression?           { minBytes, level }
s3?                    { bucket, keyPrefix, sse, sseKmsKeyId, maxDownloadBytes }
partitionDepth?        store only; default 1. Raising it distributes writes and
                       makes any shallower prefix search a Scan
indexShards?           default 8; fixed at table creation
readConcurrency?       default 8; bounds every fan-out, not only reads
maxScanItems?          default 1000
logger? metrics? tracer? clock? serde?   ports
```

Unknown keys are rejected rather than ignored: a typo in an option name is a
silent misconfiguration otherwise. Every limit in §13 is reachable from here and
nowhere else.

---

## 22. Logging catalogue

Every emitted event has a fixed level, message and **field set**, and
`test/static/log-events.test.ts` checks all three against the README's Logging
table: the message is quoted there, the Fields column names exactly what the
call attaches, and the Level column names the level it is emitted at. An event
added without its row fails the build.

| Level | Event | Fields |
|---|---|---|
| warn | list scanned a large number of rows | threadId?, checkpointNs?, scanned |
| debug | write already committed for this task and channel | sortKey, channel |
| warn | write row held by an unexpected channel | sortKey, expected, found |
| warn | compare-and-swap exhausted | namespace, key, attempts |
| error | rollback failed | sessionId, succeededCount, reason |
| error | message could not be decoded | sessionId, sortKey, reason |
| warn | offloaded object could not be deleted | operation, key, reason |
| info | lifecycle rule installed | bucket, prefix, days |

An event's `reason` is the underlying error's **name**, never its message:
messages are redacted and never logged raw.

---

## 23. Target inventory

| Module | Exports today | Target | What changes |
|---|---|---|---|
| `shared` | 81 | ~45 | one storage module, one key module, the ports |
| `checkpointer` | 56 | ~20 | the write path collapses into `shared/storage` |
| `store` | 51 | ~20 | persist, overwrite, verify and read-existing collapse |
| `history` | 28 | ~15 | the saga keeps compensation, loses its own verification |
| **total** | **216** | **~100** | |

Exports exist for consumers. Of today's 216, three are public, 92 have more than
one consumer, 111 have exactly one and nine have none — so the count is driven by
test reach, not by reuse. Tests address module boundaries instead, and the nine
with no consumer at all are deleted or made internal.

---

## 24. Checkpointer

**Write identity.** A pending write is addressed by `(taskId, channel,
occurrence)`, where `occurrence` counts earlier writes to the same channel within
one `putWrites` call. The reference saver addresses it by `(taskId, index)`.
The divergence is kept: positions are not stable across a retry whose write mix
changed, so an index-addressed row can be replayed for a channel that already
committed, which double-applies on an accumulating channel. The divergence must
stay **unobservable**: the read side deduplicates by earliest `writeGroup`
(`dropSupersededWrites`) so the replayed set equals the reference's. Any case
where it does not is a defect, not a variant, and belongs in §28.

**Inline threshold.** Computed on the assembled META row — structural
attributes, metadata descriptor, checkpoint descriptor and GSI1 attributes
together — against `MAX_INLINE_PAYLOAD_BYTES`, never on the checkpoint alone.

**`list` scoping.** Metadata filters are applied to META rows before any payload
is fetched. `limit` is honoured before the first yield, so `limit: 0` yields
nothing. A config with a `checkpoint_id` and no `checkpoint_ns` searches every
namespace, as the reference does.

**Legacy checkpoints.** The pre-v4 `pending_sends` reconstruction runs only for
rows whose `v` says so, not by probing `checkpoint.v` at read time.

**What is gone.** `storedChannels` and the parent read behind it; the special /
regular write split, the CAS, the cleanup and the verification — all subsumed by
`shared/storage` and immutable payloads. The checkpointer keeps its row model,
its key composition, its list scoping and its write identity, and nothing else.

---

## 25. Store

**Search pipeline**, one direction, no step reordered:

```
candidates → TTL filter → row narrowing → metadata filter → ranking → page
```

- *candidates*: Query on the partition when the prefix reaches
  `partitionDepth`. A shallower prefix spans partitions and is a Scan — no
  index serves a namespace prefix, because GSI1 is keyed for recency. This is
  the cost `partitionDepth` trades against, and why its default is 1.
- *row narrowing*: a row is accepted only when its own `namespace`/`key`
  attributes reproduce the key it was found at (`narrowStoreRecord`), so a
  crafted row cannot impersonate another item.
- *ranking*: natural order, or semantic. Semantic embeds **one vector per
  extracted path** and scores an item by its best-matching path (D-5). One
  concatenated embedding per item ranks a long document with a single strongly
  matching section materially lower, which is a retrieval-quality difference, not
  an edge case.
- *page*: a plain page stops reading as soon as it is full, so a namespace far
  larger than the page costs neither a full decode nor a truncation error. A
  semantic page must read every candidate to rank it, which is what
  `maxSearchCandidates` bounds.

**Text extraction** is byte-for-byte the reference's, including its treatment of
an unterminated `[` or `{` group (resolved as a plain member name). A leaf JSON
cannot represent contributes no text rather than a hole in the extracted list;
one it refuses outright — circular, `BigInt` — also contributes none, and the
write that follows is refused by the codec with a `ValidationError` naming
`value` (V-8).

**Filters.** `$eq $ne $gt $gte $lt $lte $in $nin`, plus implicit equality. An
empty condition object imposes no constraint and therefore matches everything, as
the reference does. Operator dispatch is guarded by `Object.hasOwn`, and filter
matching never walks a prototype chain.

**Namespace prefixes** are matched element-wise, so `['users']` does not match
`['userspace']`. The reference compares the joined string and does match it; this
is a divergence that is kept because the reference's behaviour is a defect, and
it is recorded in §28.

**Vector backend.** `score` is a relevance, higher is better. A backend emitting
a distance declares `vectorScoreDirection: 'distance'` and the store negates and
re-sorts; an undeclared distance is warned about and never silently reordered.
Vector dimensions are validated against `index.dims` at the first put or query,
so a model mismatch fails loudly instead of ranking noise.

**`batch`** executes operations in the caller's order. Running writes first
changes what a read in the same batch observes, and `AsyncBatchedStore` coalesces
everything enqueued in one tick into a single call, so the difference is
reachable from ordinary code.

**Concurrency.** A put reads the row it is about to replace (`createdAt`, the
payload descriptor's location and key, and the revision) and, when an offloader
is configured, commits pinned to that revision. Without an offloader there is no
object to orphan, so the put stays last-write-wins and spends no capacity on a
conditional write. The swap is what lets each of two racing writers delete
exactly the payload it superseded: without it both read the same descriptor, both
commit, and both delete it, orphaning the loser's own upload. `createdAt` is
carried forward from that read, and re-read on every swap attempt, so a row
created by whoever won keeps its true creation time.

---

## 26. History

**Chunking.** Messages are split by both the transaction item limit (99 messages
plus the session update) and an aggregate byte budget, using a deliberately
conservative per-item estimate (measured UTF-8 field bytes plus a 256-byte
allowance for attribute names and marshalling). An item larger than the budget is
placed alone rather than dropped.

**Append.** One transaction per chunk: the session update at index 0, then the
message puts, under a `ClientRequestToken` so a retry of the same chunk is
idempotent. `RETRY_EXHAUSTED` is ambiguous, so the chunk is read back
(`verifyRow`) before deciding; `committed` continues, `not-committed` compensates,
`unverified` compensates but deletes no objects.

**Compensation.** Deletes every already-committed chunk and reverts the count,
restoring the pre-call state. A failed rollback raises `COMPENSATION_FAILED`
carrying both errors, and the session's `messageCount` may then be wrong until
`reconcileMessageCount` runs.

**Counting.** `messageCount` is maintained transactionally with `ADD` on the
session row. `reconcileMessageCount` re-counts and writes back **under a
condition on the value it counted from** — a repair tool that silently clobbers a
concurrent append is not safe to run on a live session, which is what it is for.
Only live messages are counted, so the repaired number agrees with what
`getMessages` returns rather than with what the table still holds.

**TTL.** Anchored on the session row; message rows inherit it. `forceTtlRefresh`
re-anchors, and its condition sits at transaction index 0 so a lost refresh is
distinguishable from a message failure.

**Listing.** With a configured `indexName`, `listSessions` reads GSI1 in recency
order, one query per shard, merged and paged: no Scan, no in-memory sort, no
unbounded array. Without one it stays the filtered Scan of earlier releases, so
upgrading changes nothing until the index exists — but `limit` means the same
thing on both paths (the newest N) and is validated on both, and a `cursor`,
which names a position in an index that is not there, is refused rather than
answered with the first page.

**Reading.** `getMessages` is strongly consistent, decodes offloaded messages
with the same bounded concurrency as the other adapters, and applies the
`onCorruptMessage` policy in message order. An unlimited window is deliberately
uncapped — truncating a conversation is worse than a slow read, and a caller who
wants a bound passes `limit` — so a very large session is warned about, not cut
short.

---

## 27. Payload descriptor

The persisted form of an encoded value, on every row that carries one.

| Field | Meaning |
|---|---|
| `schemaVersion` | descriptor format; a higher value is refused, not misread |
| `serdeType` | the serializer that produced the bytes |
| `compressed` | whether the bytes are gzip |
| `location` | `INLINE` or `S3` |
| `bytes` | inline only |
| `s3Key` | S3 only — `<prefix>/<scope>/<row>/<sha256>.bin` |
| `size` | **new** — decoded byte length |
| `hash` | **new** — the content hash, also the key's final segment |

`size` is what makes the joint memory budget of §20 enforceable *before* a
download rather than during it, and `hash` lets a reader detect a truncated or
substituted object without trusting the store. The refusal rule already exists
for `schemaVersion` (`codec.ts:61-70`) and is the precedent the row-level `v`
follows.

---

## 28. Divergence register

Every observable difference from `MemorySaver` / `InMemoryStore`. Anything not in
this table is a defect, not a choice, and the differential oracle (§14) is what
enforces that.

| # | Divergence | Kept because |
|---|---|---|
| V-1 | Write identity is `(taskId, channel, occurrence)` | index positions are unstable across a retry; kept unobservable by read-side dedup (§24) |
| V-2 | Namespace prefixes match element-wise | the reference's string-prefix match is a defect (`['users']` matching `['userspace']`) |
| V-3 | Namespace elements may not contain `#` | the separator is structural in the sort key |
| V-4 | A namespace whose items are all deleted stops being listed | the reference retains an empty namespace with no row behind it |
| V-5 | `search` / `listNamespaces` raise `RESULT_TRUNCATED` past `maxScanItems` | silently truncating a result set is worse than refusing it |
| V-6 | Re-putting with `index: false` clears the stored vector | the reference keeps a stale vector for a changed value |
| V-7 | `batch` returns `undefined` for a put, the reference returns `null` | cosmetic; recorded so it is not mistaken for a bug |
| V-8 | A value JSON refuses (circular, `BigInt`) yields no index text instead of throwing from inside text extraction | the put is refused a moment later by the codec, with a `ValidationError` naming `value` rather than a raw `TypeError` from the embedding step |
| V-9 | Namespaces the collation calls equal are ordered by code unit | the reference leaves that pair to insertion order, which here is DynamoDB's read order, so a page boundary could fall between them differently on two calls |
| V-10 | `put` stores every channel value, never only the ones `newVersions` names | narrowing stored *nothing* when LangGraph forks a checkpoint or writes an empty update, both of which pass an empty `newVersions`. `MemorySaver.put` takes no `newVersions` either, and LangChain's validation suite exempts its own `MemorySaver`, MongoDB and SQLite savers from the delta test on the same grounds; the exemption is keyed on a module-name list, so `test/conformance/validation.conformance.test.ts` applies it by name |

Removed by this design, having previously been divergences: writes-before-reads
in `batch`, `limit: 0`, namespace-less `list` with a `checkpoint_id`, semantic
ranking, empty filter conditions.

---

## 29. Table definition

```
AttributeDefinitions : PK (S), SK (S), gsi1pk (S), gsi1sk (S)
KeySchema            : PK HASH, SK RANGE
BillingMode          : PAY_PER_REQUEST
TimeToLiveSpecification : AttributeName ttl, Enabled true
PointInTimeRecovery  : Enabled
GlobalSecondaryIndexes:
  - IndexName  : gsi1
    KeySchema  : gsi1pk HASH, gsi1sk RANGE
    Projection : INCLUDE, NonKeyAttributes [PK, SK, threadId, checkpointNs,
                 checkpointId, namespace, key, sessionId, title, messageCount,
                 createdAt, updatedAt, ttl]
```

The projection lists exactly what the three listing paths render. A projection
of `ALL` would double the index's storage and write cost for attributes no
listing reads; `KEYS_ONLY` would force a second read per listed row.

The bucket carries one lifecycle rule per configured TTL, scoped to the key
prefix, expiring at `ceil(days) + 2` so the sweep never precedes the rows it
backs.

---

## 30. Public API

Unchanged in shape: `getTuple`, `list`, `put`, `putWrites`, `deleteThread` on the
saver; `get`, `search`, `put`, `delete`, `batch`, `listNamespaces` on the store;
`getMessages`, `addMessages`, `addMessage`, `clear`, `forSession` on the history.

Changed for 1.0:

```ts
// paged, instead of an unbounded array built by a Scan
listSessions(options?: {
  limit?: number;
  cursor?: string;
  signal?: AbortSignal;
}): Promise<{ sessions: SessionMetadata[]; nextCursor?: string }>;

// the repair tool, now safe on a live session
reconcileMessageCount(sessionId: string, options?: CancelOptions): Promise<number>;
```

New options: `tenant`, `partitionDepth`, `indexShards`, `readConcurrency`,
`metrics`, `tracer`, `clock`, `deriveTitle`.

A cursor is opaque, valid only against the same table and format version, and
carries no caller-readable structure.

---

## 31. Retry and backoff

**One policy, honoured everywhere.** `retry` configures every DynamoDB and S3
call. No call site substitutes its own constants — `drain-unprocessed.ts:37`
does today, so a caller raising `baseDelayMs` still gets 100 ms there.

**Classification.** An error is retryable when its name, or any name in its
`cause` chain (bounded at 32 links), is a known transient signal — throttling,
`InternalServerError`, `ServiceUnavailable`, `TransactionConflictException`,
`TransactionInProgressException`, and the transport errors (`ECONNRESET`,
`ETIMEDOUT`, `EAI_AGAIN`, …) — or when the HTTP status is 429, 500, 502, 503 or
504. The status rule exists for errors the SDK could not map to a modelled
exception, which arrive as `name: 'Unknown'` carrying only a status.

`TransactionCanceledException` is **not** retryable by name: its cancellation
reasons mix permanent and transient causes. It is retried only when every reason
that is not `None` is itself transient.

**Backoff.** Exponential from `baseDelayMs`, capped at `maxDelayMs`, with full
jitter from the injected `rng`. Attempts default to 5 and are capped at 100.
Message append has a floor of 18 attempts: a hot session is genuine row
contention, and a caller policy may raise that budget but never lower it.

**Cancellation.** The backoff wait is the cancellation point; an aborted signal
rejects with `ABORTED` rather than sleeping out the delay. Verification and
cleanup reads do not take the signal (§7).

**A retry is not a second write.** Every retried operation is idempotent by key,
by content hash, or by `ClientRequestToken`, so a duplicate delivery cannot
create a duplicate row. Where that is impossible — a transaction whose response
is lost — the outcome is resolved by reading, never assumed (§8).

---

## 32. Compression and serialization

**Compression.** Gzip above `minSizeBytes` (default 1 KiB), at `level` (default
6). The result is kept only when it beats 90% of the original; otherwise the
bytes are stored raw. Whether the bytes are compressed is **recorded in the
descriptor, never inferred from the bytes** — sniffing a gzip magic number would
misread a payload that legitimately begins with those bytes.

**Decompression** is bounded by zlib's own `maxOutputLength`, so a compression
bomb fails during inflation rather than after allocating. The bound participates
in the joint per-call budget of §20.

**Serialization.** The `Serde` port produces `[serdeType, bytes]`, and
`serdeType` is stored with the payload. A reader that does not recognise a
`serdeType` fails with `FORMAT_UNSUPPORTED` and names it; it never guesses.
Changing the serializer is therefore forward-safe — new rows carry the new type,
old rows keep reading with the old one — and requires no data migration. That is
why serde versioning is independent of the row's `v` (§11).

---

## 33. Time to live

**Expression.** `{ days }` or `{ seconds }`, never both, each a positive integer
capped at five years. An object carrying both keys is rejected rather than
resolved by whichever key is inspected first.

**Application.** A TTL timestamp is computed once per call and applied to every
row that call writes, so a checkpoint's META, PAYLOAD and WRITE rows expire
together and a chunked append does not leave half a session outliving the rest.

**Visibility.** DynamoDB's sweep lags by up to 48 hours, so an expired row can
still be returned by a query. Every read filters on the TTL attribute itself:
**an expired row is absent to every reader the moment it expires**, regardless of
when the service removes it. This is a correctness rule, not an optimisation — a
resumed thread must not see state the caller believes expired.

**S3.** The lifecycle rule expires objects at `ceil(days) + 2`, so the sweep can
never precede the rows that reference them. The rule is scoped to the configured
key prefix and installed by `ensureS3LifecycleRule()` at deployment time, which
throws rather than logging: a missing lifecycle rule means offloaded objects
accumulate forever, and that must fail a deployment.

**History anchoring.** The session row carries the anchor and message rows
inherit it, so an active session does not expire mid-conversation. A refresh is
the first item of the append transaction, which makes a lost refresh
distinguishable from a failed message write.

---

## 34. Shared tables and the factory

`DynamoDBFactory.createAll()` places all three adapters on one table. That is
safe only because the key spaces are provably disjoint: every partition key
begins with an adapter tag, and the three tags differ in their **first**
character, so no composed key from one adapter can equal another's whatever the
caller's identifiers are. Identifiers may not contain the separator, which is
what keeps the segment boundaries unambiguous.

Partition-wide operations (`deleteThread`, `clear`) query the partition and
delete only rows whose sort key the adapter owns, leaving a foreign row in place
and logging it. A partition-wide delete is never issued blind.

**Client ownership.** An injected `client` is never destroyed by an adapter; a
client the adapter built is destroyed by `destroy()`. `createAll()` builds one
client, shares it, and returns the one `destroy` that releases every adapter and
that client, once. That teardown is total: one adapter failing to release its
own resources is logged and the rest are still released, both when the caller
calls `destroy` and when a failed build rolls itself back — where a throw would
also replace the constructor error the caller needs. In Lambda the client is
constructed outside the handler and reused, which the design requires and the
options make possible.

**What the shared client displaces.** An adapter may not be given a
`clientConfig` beside a `client`, because for the client it would be silently
ignored. So `createAll` carries forward what that config still decides
elsewhere: the S3 region, which each adapter would otherwise read off its own
`clientConfig` and which addresses a bucket the SDK cannot reach by redirect.
Sections themselves are checked against the three names, so a misspelt one is
refused instead of building nothing.

---

## 35. Redaction

One path. Every message that reaches an `Error` or a log passes the same
redaction, including the text of a wrapped upstream error — today
`upstream-error.ts:25-30` embeds the cause's message raw while `retry.ts:88` and
`errors.ts:130` redact it.

**What it guarantees.** Key-based redaction for names that normalise to a known
secret name, and value-based redaction for high-confidence patterns (AWS access
key ids, bearer tokens, private-key headers).

**What it does not guarantee.** It is a defence in depth, not a boundary: a
secret in an unrecognised field name or format passes through. The documentation
says exactly that. A design that claimed completeness here would be inviting
callers to log secrets deliberately.

**Cost.** The walk memoises visited nodes rather than re-walking shared
subgraphs. The current path-scoped guard is correct for cycles but exponential on
a directed acyclic graph — 25 shared objects take 70 seconds — and
`redactSecrets` is a public export, so that is reachable from caller code.

---

## 36. Idempotency

| Operation | Idempotent by | Duplicate delivery does |
|---|---|---|
| `saver.put` | checkpoint id + row key | rewrites the same row with the same content |
| `saver.putWrites` | `(taskId, channel, occurrence)` + `attribute_not_exists` | is turned away by the guard |
| `store.put` | namespace + key; payload by content hash | rewrites the same row; the object already exists |
| `history.addMessages` | `ClientRequestToken` per chunk | is rejected by DynamoDB as the same transaction |
| `deleteThread` / `clear` | the absence of rows | deletes nothing |
| S3 upload | content hash | writes identical bytes to the same key |

Content addressing is what makes an S3 upload idempotent: retrying it cannot
produce a second object, so a lost response costs nothing and needs no cleanup.

---

## 37. Migration tooling

**`backfillGsi1`.** Scans the table once, writes `gsi1pk`/`gsi1sk` on the three
indexed row kinds, and reports progress and a resumable cursor. While the index
is incomplete the listing paths fall back to their current behaviour, so the
backfill runs without downtime and without a flag day.

**Store layout.** Moving `partitionDepth` rewrites keys, so it is a copy, not an
update: the tool writes the new key and deletes the old one per item, and readers
accept both layouts for the duration. The migration is complete when a scan finds
no rows at the old depth.

**Verification.** Every migration tool has a `--check` mode that reports what it
would change and a post-migration assertion that the counts match. A migration
that cannot be verified is not shipped.

**Fixtures.** A corpus of rows written by 0.9 — with and without
`storedChannels`, `rev`, `occurrence`, `writeGroup` — is committed as test data,
and the backward-compatibility tier (§14) reads it on every run. That corpus is
what makes the `v = 0` reading rules testable instead of theoretical.

---

## 38. Tenant isolation

With `tenant` configured, it is the first segment of every partition key and the
first segment of every S3 scope. Isolation is then enforceable by IAM rather than
by convention:

```json
{
  "Effect": "Allow",
  "Action": ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"],
  "Resource": "arn:aws:dynamodb:*:*:table/app-table",
  "Condition": {
    "ForAllValues:StringLike": { "dynamodb:LeadingKeys": ["CHKPT#${aws:PrincipalTag/tenant}#*"] }
  }
}
```

The key is sharded within the tenant (§17 D-3), so a large tenant does not become
a hot partition. Without `tenant`, isolation remains implicit in the caller's
thread ids and namespaces, and the documentation says so rather than implying a
guarantee that is not there.

**A row may only speak for the partition it lives in.** IAM confines a writer to
its own partition, but a row also carries attributes — a store item's
`namespace`/`key`, a checkpoint META row's `threadId`/`checkpointNs`/
`checkpointId` — and those attributes name the S3 scope its payload is read
under. A writer that could put another tenant's identifier on a row in its own
partition could therefore have a reader fetch that tenant's offloaded object and
hand it back. Every row narrowing tests that the attributes reproduce the
DynamoDB key the row was found at, so the two can never disagree (SEC-03).

---

## 39. Release engineering

The package is only as trustworthy as the pipeline that publishes it.

- **The gate asserts a required-checks list**, not a count of whatever check runs
  happen to exist at the moment of the first poll. Today it compares
  `done_ok = total` against currently registered runs, so a poll landing while
  only the fast audit job exists publishes without the unit matrix, integration,
  conformance or package smoke having run.
- **Every action is pinned by commit SHA**, including third-party ones in the
  workflow that holds `id-token: write` and an AWS role.
- **No workflow downloads an installer from a movable tag** without a checksum.
- **Every workflow declares `permissions`**; none inherits the repository
  default.
- **Publishing is OIDC trusted publishing with provenance**, never a long-lived
  token.
- **The tarball is asserted**: the shipped file list, the absence of source maps
  and fixtures, `publint`, `attw`, and a byte-identical rebuild of `dist/` from
  source.

**Deprecation.** A public export is removed only one major version after it is
documented as deprecated, and the deprecation is machine-checked so it cannot be
forgotten.

---

## 40. What "done" means

This design is satisfied when all of the following hold, each checkable by
someone who did not write the code:

1. No read scans where a key condition could have served it, and the two that
   enumerate every row by construction are named in D-1 and bounded.
2. One implementation of the write outcome: every ambiguous write is resolved
   through `verifyRow`, and no adapter declares a verdict type of its own.
3. Every row carries `v`; no behaviour is inferred from a missing attribute.
4. Every identifier passes one validation, including UTF-16 well-formedness.
5. No operation issues an unbounded number of requests or holds an unbounded
   number of decoded payloads.
6. Every public method's contract states consistency, idempotency, atomicity and
   cost, and matches §6.
7. Every observable difference from the reference implementations appears in §28,
   and the differential oracle finds no other.
8. Every claim in the documentation about external behaviour carries a citation
   that resolves.
9. Every function's accepted input domain is closed (`CONTRACTS.md`).
10. The release gate names the checks it requires.

---

## 41. The base methods this package does not implement

`BaseCheckpointSaver` has five abstract methods and two concrete ones. This
package implements the five and inherits both concrete ones
(`@langchain/langgraph-checkpoint@1.1.5` `dist/base.d.ts:59-117`). That is a
design decision by omission today; it is made explicit here.

**`getNextVersion(current)` — inherited, deliberately.** The default numeric
versioning is the contract the reference savers use; a custom scheme would make
this package's checkpoints incomparable with theirs.

**`getDeltaChannelHistory` — overridden, to make a TTL hole audible.** The
inherited walk follows `parentConfig` with `getTuple` and stops at the first
ancestor it cannot read: `if (tup === void 0) break`
(`@langchain/langgraph-checkpoint@1.1.5` `dist/base.js:88`). It then reports no
seed for the channels still unresolved, and the consumer rebuilds each from its
initial value — `fromCheckpoint(undefined)` falls through to
`initialValueFactory()` (`@langchain/langgraph@1.4.13`
`dist/channels/delta.js:65`). Nothing in the return shape can say "incomplete".

This package can produce exactly that state. A TTL is computed per put
(`Math.floor(now()/1000) + ttlSeconds`), so a thread that lives longer than its
TTL expires its own older checkpoints while the newer ones remain. The override
therefore keeps the inherited algorithm and changes one cell of its domain: an
ancestor that cannot be read is probed once, ignoring expiry (`ancestor-probe.ts`),
and an ancestor that *exists but has expired* raises `ANCESTOR_EXPIRED` instead
of ending the walk. An ancestor that was never written, or a parent pointer that
names no checkpoint, still ends it quietly — those are ordinary roots. The probe
costs one extra `GetItem` on the failure path only.

The walk is **not** shallow. A delta channel writes a full `DeltaSnapshot` into
`channel_values` only every `snapshotFrequency` updates (default 1000) or every
`DELTA_MAX_SUPERSTEPS_SINCE_SNAPSHOT` supersteps (default 5000,
`dist/constants.js:32-39`), and "for non-snapshot steps the channel does not
appear in `channel_values`" (`dist/channels/delta.js:113-119`). Storing every
channel value on every checkpoint (§3.2) does not change that: the channel never
hands the value to the checkpoint in the first place. So the seed can be up to
`snapshotFrequency` ancestors back, and the walk costs one `getTuple` per
ancestor — a META read, a payload read and a writes query each.

That per-ancestor cost is worth collapsing into a single Query over the
partition, which is what the checkpointer's key layout allows. It is **not** done
here, deliberately: the method is Beta upstream and a bespoke reimplementation
would have to track its replay semantics (`Overwrite` reset points,
`DeltaSnapshot` unwrapping) rather than just its I/O. The override stays a
one-cell change to the inherited walk, and the optimisation is recorded in §42
as a specification, not as code.

**Beta exposure.** `getDeltaChannelHistory` is marked Beta in
`@langchain/langgraph-checkpoint` and `DeltaChannel` in `@langchain/langgraph`;
both say the shape may change. The override is written against the pinned peer
range, its signature is pinned to the base contract by a type test
(`test/types/public-surface.test.ts`, `toEqualTypeOf<BaseCheckpointSaver[...]>`)
so a peer bump that changes the shape fails the build, and its behaviour is
covered by unit tests over both the module and the saver. There is **no**
conformance-tier test for it: the upstream validation suite does not exercise it,
and running a real `DeltaChannel` graph against DynamoDB Local is recorded in
§42 as outstanding.

---

## 42. Remaining specifications

**Delta-channel history in one Query.** Every checkpoint of a thread and
namespace lives in one partition, sorted by id, so the ancestor walk
`getDeltaChannelHistory` performs — today one `getTuple` per ancestor, up to
`snapshotFrequency` of them (§41) — is expressible as one Query for the META
rows plus one for the writes. Not implemented while the upstream method is Beta,
because a bespoke walk must also reproduce its replay semantics (`Overwrite`
reset points, `DeltaSnapshot` unwrapping), not only its reads.

**A conformance test for delta channels.** A compiled graph with a
`DeltaChannel` (a low `snapshotFrequency`, several supersteps) run against
DynamoDB Local, asserting the reconstructed channel matches `MemorySaver`'s. The
upstream checkpointer validation suite does not exercise the method, so the
override is currently covered by unit tests only (§41).

**Metric names.** Emitted through the `Metrics` port, one namespace, stable:

```
dynamodb.request.duration_ms   tags: operation, table, outcome
dynamodb.request.attempts      tags: operation
dynamodb.request.throttled     tags: operation
dynamodb.capacity.consumed     tags: operation, kind (read|write)
payload.size_bytes             tags: adapter, location (inline|s3)
payload.offloaded              tags: adapter
payload.compression_ratio      tags: adapter
index.fanout                   tags: operation
cas.exhausted                  tags: adapter
verify.outcome                 tags: adapter, outcome
```

**Error context.** Every error carries `code`, and a `context` object whose keys
are identifiers and counts only — never payload content, never a caller value
that could be personal data. `cause` holds the underlying error, redacted.

**Store index options.**

```
index?: {
  dims: number;            // validated against the first vector seen
  fields: string[];        // JSON paths, extracted exactly as InMemoryStore does
  embeddings: Embeddings;  // the model
}
vectorBackend?: VectorBackend;
vectorScoreDirection?: 'relevance' | 'distance';
```

`fields` are extracted with the same path semantics as the reference, and each
extracted path is embedded separately (§25). A dimension mismatch fails at the
first put or query rather than ranking noise.

**Vector and row consistency.** DynamoDB holds the canonical item; the vector
backend is a derived index. A lost vector write is repaired by
`reconcileVectorIndex`, which re-pushes every live item's embedding and, when the
backend implements `listKeys`, prunes vectors whose item is gone. The row is
never deleted on a vector failure: an item without a vector is findable by key
and invisible to semantic search, which is recoverable; the reverse is not.

**Benchmarks.** A suite against DynamoDB Local records, per operation, the round
trips and the peak resident bytes of §20. It runs in CI on a schedule rather than
per commit, and a change in either number is a reviewable diff rather than a
number nobody looks at.

**Documentation deliverables.** README (quick start, options, limits, cost table,
the §28 divergence register), this document, `CONTRACTS.md`, `STABILITY.md`,
generated API docs, and a migration guide per major version. Every claim in them
about external behaviour carries a citation that resolves (§40.8).

---

## 43. Coverage of this document

What a reader should be able to find here, and where:

| Question | Section |
|---|---|
| What does it store, and under which keys | 3, 29 |
| How is every read served, and what does it cost | 2, 4, 20 |
| What does each public method promise | 6, 7, 36 |
| What happens when a write fails | 8, 19.1, 31 |
| How are large values handled | 5, 27, 32 |
| What is the security posture | 9, 35, 38 |
| How is it configured | 21 |
| What does it emit | 22, 42 |
| How is any of this proven | 14, 37, 42 |
| What may differ from the reference | 28 |
| How does it get to production | 15, 16, 39 |
| Why was each choice made | 17, 18 |
| When is it finished | 40 |
