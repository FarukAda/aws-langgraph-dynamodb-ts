# @farukada/aws-langgraph-dynamodb-ts — In-Depth Guide

The [README](../README.md) is the entry point: installation, the quick start, the usage
examples and a scannable summary of every topic below. This guide is where that summary
links to for the mechanism behind the promise — the compare-and-swap and request-token
machinery behind S3 offload, what a partition delete promises and what it costs, search
and vector-index consistency, checkpointer and chat-history semantics, the request-unit
cost of every call plus a worked example, what can still go wrong between a DynamoDB row
and its S3 payload and the sweep that finds a stranded one, and the on-disk layout and
error/version guarantees behind [Versioning and compatibility](../README.md#versioning-and-compatibility).
Every fact here is read from the same `src` the README is checked against.

## Contents

- [Infrastructure as code](#infrastructure-as-code)
- [S3 offloading](#s3-offloading)
- [S3 lifecycle rules in depth](#s3-lifecycle-rules-in-depth)
- [Overwrite races and orphaned objects](#overwrite-races-and-orphaned-objects)
- [Write idempotency](#write-idempotency)
- [What a token guarantees, and what it does not](#what-a-token-guarantees-and-what-it-does-not)
- [What a token costs](#what-a-token-costs)
- [What a partition delete promises](#what-a-partition-delete-promises)
- [What a partition delete costs](#what-a-partition-delete-costs)
- [TTL expiry](#ttl-expiry)
- [Plain (metadata) search](#plain-metadata-search)
- [Semantic search](#semantic-search)
- [Vector index consistency](#vector-index-consistency)
- [Checkpointer semantics](#checkpointer-semantics)
- [Chat history semantics](#chat-history-semantics)
- [What each operation costs](#what-each-operation-costs)
- [Cost in request units: a worked example](#cost-in-request-units-a-worked-example)
- [Monitoring](#monitoring)
- [What can still go wrong](#what-can-still-go-wrong)
- [Finding rows whose payload was released](#finding-rows-whose-payload-was-released)
- [Lambda and other short-lived runtimes](#lambda-and-other-short-lived-runtimes)
- [The on-disk layout](#the-on-disk-layout)
- [Errors, logs and row versions](#errors-logs-and-row-versions)
- [Differences from the reference implementations](#differences-from-the-reference-implementations)

## Infrastructure as code

One table backs all three adapters — the [README's Infrastructure setup](../README.md#infrastructure-setup) section creates it with the AWS CLI or against DynamoDB Local. These two definitions are the same table, for a deployment that already provisions with AWS CDK or Terraform.

<details>
<summary><strong>AWS CDK (TypeScript)</strong></summary>

<!-- sample:skip aws-cdk-lib is not a dependency of this package -->
```typescript
import { Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type { Construct } from 'constructs';

export class LangGraphTableStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const table = new dynamodb.Table(this, 'LangGraph', {
      tableName: 'langgraph',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl', // optional; only needed if you use the `ttl` option
    });

    // Optional: the recency index. Add it, run backfillRecencyIndex(), then set
    // `indexName: 'gsi1'` on the saver and the history. Without it every listing still works.
    table.addGlobalSecondaryIndex({
      indexName: 'gsi1',
      partitionKey: { name: 'gsi1pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'gsi1sk', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
  }
}
```

</details>

<details>
<summary><strong>Terraform</strong></summary>

```hcl
resource "aws_dynamodb_table" "langgraph" {
  name         = "langgraph"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  ttl { # optional; only needed if you use the `ttl` option
    attribute_name = "ttl"
    enabled        = true
  }

  # Optional: the recency index. Add it, run backfillRecencyIndex(), then set
  # `indexName = "gsi1"` on the saver and the history. Without it every listing still works.
  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name            = "gsi1"
    hash_key        = "gsi1pk"
    range_key       = "gsi1sk"
    projection_type = "ALL"
  }
}
```

</details>

Both definitions match the AWS CLI command in the README exactly: the same `PK`/`SK` string keys, `PAY_PER_REQUEST` billing, and the same optional `gsi1` recency index with an `ALL` projection — required because the recency-index reads listed under [Maintenance operations](../README.md#maintenance-operations) read the row straight off the index, not through a follow-up `GetItem`.

## S3 offloading

Set `s3: { bucketName }`. Any serialized payload at or above `thresholdBytes` (default 350 KB) is written to S3, with only a reference stored in DynamoDB. Reads rehydrate transparently.

- **Only the payload counts toward the threshold.** The store's inline vectors sit on the same item and are not weighed against it — but they still share the item's 400 KB ceiling. Budget up to about 10 bytes per dimension **per extracted text**: the store embeds one vector per text its `index.fields` extract, so `fields: ['title', 'body', 'summary']` at 1024 dims costs roughly 30 KB, not 10 KB, and a wildcard path such as `sections[*].text` costs one vector per element. A row that payload and those vectors would take past DynamoDB's 400 KB item limit is refused with a `VALIDATION` error naming `index`, before anything is written or left uploaded.
- **Peer dependency.** Requires the optional `@aws-sdk/client-s3` peer: constructing an adapter with `s3` starts loading it, and a missing package fails the first S3 operation with a `VALIDATION` error naming the install command — bundlers must keep it installed or external.
- **Cleanup.** Deleting a checkpoint thread or chat session also best-effort deletes its offloaded objects.

**Lifecycle rules.** When a `ttl` is also configured, call `ensureS3LifecycleRule()` once (e.g. during deployment) to install the matching S3 lifecycle rules ([their shapes](../README.md#s3-lifecycle-rules)).

- It **throws** when a rule cannot be written rather than logging — a `VALIDATION` error for a `keyPrefix` it will not scope a rule to, the code the classifier assigns for anything S3 refuses (most often `ACCESS_DENIED` for a missing `s3:PutLifecycleConfiguration`), and `CONTENTION` when a re-read never shows its rules through five writes because another writer keeps replacing the configuration — so call it from a provisioning step and treat a rejection as a deployment error, not as something to ignore.
- Its one best-effort step is the versioning probe that follows the write, which warns instead of throwing (see [Maintenance operations](../README.md#maintenance-operations)).
- It is opt-in rather than automatic because it needs that broader bucket-level permission and is not safe to fire on every adapter construction.
- If you configure `ttl` + `s3` but never call it, nothing reclaims objects that best-effort cleanup misses — they stay in the bucket until you remove them or add a lifecycle rule yourself.

## S3 lifecycle rules in depth

`ensureS3LifecycleRule()` writes two rules, both scoped to the adapter's `keyPrefix`; the README's [S3 lifecycle rules](../README.md#s3-lifecycle-rules) section gives their JSON shapes verbatim. This is the mechanics behind them: how the floor is measured, what survives a rewrite, and what "reported, never enforced" costs an operator who does not read the `warn`.

**The floor is measured, not fixed.** `NoncurrentDays` — the grace a released payload gets before its delete marker is reclaimed — is a floor, never a cap, and the floor is measured against **every rule that already governs these keys**: the longest `NoncurrentDays` among them is what gets written. S3 honours the *shorter* of two overlapping expirations, so a prefix-scoped one-day rule written beside a bucket-wide 90-day retention would quietly cut the real window under this prefix from 90 days to one; taking the longest is what makes "nothing here shortens a retention you chose" true rather than merely intended.

Only an `Enabled` rule counts — a disabled one expires nothing, so it neither shortens a window nor raises this floor. An enabled rule governs these keys when it:

- names no prefix at all: bucket-wide, or filtered only by tags or object size. A filter this library cannot read in full is taken to cover everything, which is the safe direction for your recovery window — it can only lengthen retention. Safe is not free: a longer floor holds another day of released payloads for every day it adds, and since a delete marker is only reclaimed once its last noncurrent version has expired, the marker set under the prefix grows with it, which is what an out-of-band sweep over these keys has to walk. Reading a prefix out of `Filter.And` makes an unreadable filter rare rather than impossible;
- names a prefix in `Filter.Prefix` that this `keyPrefix` starts with;
- names that prefix somewhere else the schema allows — nested in `Filter.And.Prefix` beside tags or size bounds, or in the older top-level `Prefix` — and this `keyPrefix` starts with it.

A rule scoped beside this prefix, or beneath it, is left out: it governs none of these keys, or only some of them.

**The floor ratchets.** This library's own rule is one of the rules it measures against, so a value written once outlives the rule that justified it — delete your bucket-wide 90-day rule and the 90 days stay, because lowering them is exactly the silent shortening this is here to prevent. The way back down is to delete this library's rule and call `ensureS3LifecycleRule()` again, which writes it afresh at the one-day grace.

**What survives a rewrite.** Fields on either rule that this library does not manage survive the rewrite a changed `ttl` triggers: `NewerNoncurrentVersions`, `Transitions`, `NoncurrentVersionTransitions` and `AbortIncompleteMultipartUpload` are carried across. A rule written in the older schema — a top-level `Prefix` and no `Filter` — is **upgraded** to a `Filter` rather than carried across beside one, since the two are alternatives and a rule holding both is refused. Only the `Expiration` is replaced outright rather than merged: merging this library's `Days` into a `Date` you set would change the expiry you configured.

**It reads back what it wrote.** S3 serves a bucket's configuration eventually consistently, so a read made right after a write — this adapter's, or another adapter's on the same bucket a moment earlier — can still return the configuration from before it, and a write built on that read would silently drop the rules the earlier write added. `ensureS3LifecycleRule()` therefore reads the configuration again after every write and writes once more, merged with whatever it now finds, until both of its rules are there; it waits 1, 2, 4 and then 8 seconds before those rewrites, and fails with `CONTENTION` after five writes that did not stay.

The second rule reclaims the delete markers themselves, once the last noncurrent version under a key has expired. It has to be a separate rule — S3 rejects `ExpiredObjectDeleteMarker` inside an `Expiration` that also carries `Days`, with `MalformedXML` — and without it every release leaves a marker that never goes away.

**Versioning is reported, never enforced**, and that makes it the largest thing here that nothing stops you getting wrong: `ensureS3LifecycleRule()` reads the bucket's versioning state after it has written the rules and logs a `warn` for anything but `Enabled` (see [Logging](../README.md#logging)) — it never refuses, because the rules are worth writing either way and a deployment that worked yesterday on an unversioned bucket must not start failing today. The `warn` is the entire mechanism, and an operator who does not read it — or who never calls `ensureS3LifecycleRule()`, and so never gets it — can be running the prevention layer on an unversioned bucket without knowing. There is no grace window behind it there: every release is a real delete, [the sweep](#finding-rows-whose-payload-was-released) has no delete marker to list, and a row that does end up naming a released object is unrecoverable rather than restorable.

The library never calls `PutBucketVersioning` on your behalf: versioning is bucket-wide, cannot be switched off once enabled (only suspended), and starts billing for every version of every object in the bucket, so enabling it is a decision for whoever owns the bucket. Suspending it is the worse of the two states, and the `warn` says so separately: a write then takes the null version, a second write replaces it outright, and versions written while versioning was on keep costing storage.

## Overwrite races and orphaned objects

Both the store's concurrent-`put` overwrite race and the checkpointer's *special*-write overwrite race (`__error__`, `__interrupt__`, `__resume__`, `__scheduled__`) are held by **two** mechanisms, and each answers a different question.

- The **compare-and-swap** decides *which* payload a write supersedes: each overwrite pins the previous descriptor it observed and re-reads on rejection, so it deletes exactly the payload it actually superseded instead of racing another writer for the same one.
- The **client request token** decides that a re-sent request lands *once*: a write whose payload was offloaded goes out as a one-item `TransactWriteItems` carrying a token drawn once per retry budget, so every attempt of that budget re-sends the identical request, and a retry that follows a lost acknowledgement is answered from DynamoDB's idempotency cache instead of putting the row back after a concurrent delete or a `ttl` sweep has released the object it names — a live row naming a deleted object, which every later read fails on.

The two are not interchangeable, and [Write idempotency](#write-idempotency) below is why: the token says nothing about a write whose condition turned it away, and that is exactly the write the compare-and-swap then re-pins and re-issues — under a fresh token, because the re-pinned request is no longer the same request.

A leak from either path remains possible in these cases, all backstopped by `ensureS3LifecycleRule()`:

- the bounded compare-and-swap (3 attempts) is exhausted under pathological contention, which falls back to an unconditional overwrite and logs a `warn`;
- a best-effort delete genuinely fails;
- a failed write cannot be verified, or a special write's first read of its row fails, so nothing is deleted; or
- one double-fault interleaving — a write that loses the swap and then exhausts its transient-error retries on an attempt that actually landed — leaves cleanup releasing the stale descriptor rather than the one it truly superseded, orphaning that one.

Every write uploads under an id of its own — a store put's `rev`, a checkpoint put's ULID, a `putWrites` call's `writeGroup`, a history message's ULID — so no row another write commits names its objects, and no cleanup reads the row again before it deletes: a `store.put` or special write releases the payload it superseded once its own write has committed, `store.delete` releases the object of the row it removed, and a failed `store.put`, `saver.put` or `putWrites` releases its own uploads only once a read of the row, or the row returned with a rejected write, shows that the row does not hold its write. Uploads are sent with `If-None-Match: *`, so a retried upload request writes nothing new, and two writes of the same bytes store two objects.

Separately, and unchanged by any of the above, the checkpointer's *regular* (non-special) writes still resolve a genuine race first-write-wins with no compare-and-swap, so the loser's own upload there remains an orphan reclaimed only by best-effort cleanup and `ensureS3LifecycleRule()`. A store `delete` closes a different gap: once the row is gone with its acknowledgement, nothing could say which object it had referenced. It reads the row before removing it, so the object of a delete whose acknowledgement is lost is released from that observation rather than left behind.

## Write idempotency

Some of the writes this library sends carry a **client request token**, which DynamoDB honours by treating a re-sent request as the same request rather than a new one for ten minutes. Three kinds of write carry one:

- every write that references an offloaded S3 object, whichever adapter sends it;
- the writes that are `TransactWriteItems` in their own right, which carry a token whether or not anything was offloaded — `saver.put`'s two rows, a `history.addMessages` chunk with its session row, and the session-row writes that roll such an append back; and
- the row removal inside `store.delete`.

Everything else carries none — an inline `PutItem`, the per-row deletes of `deleteThread()`/`clear()`, and the `BatchWriteItem` that rolls back a failed multi-chunk append (that API accepts no token at all).

Nothing in the token enforces those ten minutes — a re-send that arrives after them is simply a new request, and is applied — so this library's own budget does: a tokened write stops starting new attempts 300 s in, half the window, and the other half absorbs the attempt still in flight (see [Retries and backoff](../README.md#retries-and-backoff), which is also where that last attempt's own bound is, and where an injected client can give it up).

## What a token guarantees, and what it does not

A write whose first attempt **committed** is applied exactly once, at that moment — a later writer supersedes it normally, and a concurrent delete stands. A write whose first attempt was **rejected by its condition** carries no idempotency at all: a cancelled transaction never completes, so DynamoDB caches no result for its token, and a retry with the same token is a **fresh evaluation** against the table as it stands at retry time.

The short version — "a retried write lands once" — is therefore false, and two further readings are wrong for the same reason. It is a statement about writes **this library sends with a token**, so it says nothing about a `BatchWriteItem`, which can carry none; and it says nothing about a first request that was already wrong, because a token only makes a *re-sent* request harmless and a race that needs no retry to go wrong is untouched by it. "Exactly once" is also about **application, not ordering**: a cancelled-then-retried write applies later than its first attempt, or not at all.

## What a token costs

A one-item transaction costs **2 write units per KB** where the `PutItem` it replaces cost 1 — on the offloaded write paths only, so an inline write is unchanged.

On a *contended* row it also costs about **2.6 requests per logical write**, because most attempts come back as retryable transaction conflicts rather than as a clean win-or-lose: measured against DynamoDB, conflicts were 38% of attempts with two writers racing on one row, 65% with five and 86% with twenty, against 0% at every width for the plain conditional `PutItem` this replaces.

Size a table's write capacity for the units and a bill for the requests: uncontended an offloaded write is 2× the units and 1× the requests of a plain conditional put, and on a hot row it is roughly five times the cost. The budget absorbs the conflicts — they are retried, not surfaced — and `putWrites`' inline fan-out stays at 1× both, which is why the token is scoped to the writes that reference an object rather than to every write of an S3-enabled adapter. A worked example of the 2× in request units is below, under [Cost in request units: a worked example](#cost-in-request-units-a-worked-example).

## What a partition delete promises

`deleteThread()` and `clear()` remove exactly the rows their one partition read observed, and nothing else. Each row goes out as its own `DeleteItem` conditioned on the per-write id that read saw on it — a pending write's `writeGroup`, a session row's own `writeId`, or the `writeId` inside the payload descriptor a checkpoint or message row carries — so a row **rewritten between the read and its delete is refused rather than removed**.

The refusal is the whole of the promise: that rewrite was a write already acknowledged to its author, and deleting it would take the row *and* release the S3 object the rewrite had uploaded, leaving nothing behind to say either had happened. A refused row is left exactly as its writer left it, nothing it names is released, and it is logged at `warn` with its sort key and counted as skipped rather than deleted; the call itself still resolves. Refusals also carry forward inside a checkpoint: its rows arrive `META`, then `PAYLOAD`, then `WRITE`, and each kind is settled before the next is issued, so a refused checkpoint takes the rest of its own rows out of the pass instead of being half-deleted.

Two limits stay, and neither is softened by the pin:

- A row written at a key the read never saw still survives the pass — that is the quiescence caveat, unchanged.
- A row written before these ids existed (before `1.0.0-rc.2`) carries none, so it is deleted unconditionally exactly as every row once was. This makes the promise **temporal**: a table upgraded in place drains into it as its rows are rewritten, and a table started on `1.0.0-rc.2` or later already has every row covered.

Re-running the call once the partition is idle is the remedy for every row a pass leaves behind, and [*What can still go wrong*](#what-can-still-go-wrong) lists the shapes one can take.

## What a partition delete costs

One conditional `DeleteItem` per row, where an unconditional `BatchWriteItem` delete would carry twenty-five rows per request — **about 25× the requests**, so a 10 000-row thread costs roughly **10 000 requests** against the ~400 a batched, unconditional delete would need. There is no cheaper shape that still refuses anything: `BatchWriteItem` silently ignores a condition written on a delete request and removes the row anyway.

The pass still buffers twenty-five rows at a time and keeps at most **8 requests in flight** — a fixed number, not an option — so a partition of any size opens at most eight sockets rather than one per row, and the memory it holds is bounded by the buffer rather than by the partition. Neither bound is on the *time*: the requests are the 25× above and they go out eight at a time, so a wide thread takes proportionally longer to empty than a batched delete would, and nothing here caps that.

**Write capacity for the rows actually deleted is unchanged**: a conditional `DeleteItem` is charged what the unconditional one was, and this path sends no transaction, so nothing here doubles the units the way an offloaded write does. What DynamoDB bills for a *refused* delete is **not a figure this project has measured**, and it is left unstated rather than guessed at — a cost table that quotes an unmeasured number is how a cost table becomes fiction. Size for the request count first: on a wide thread that is the term that grew.

## TTL expiry

Set `ttl: { days }` or `ttl: { seconds }`. The `ttl` attribute is written as a Unix-epoch-seconds timestamp; enable DynamoDB TTL on the `ttl` attribute for automatic deletion. Every adapter filters rows past their `ttl` on read — `get`/`search`/`listNamespaces` in the store, `getTuple`/`list` in the checkpointer, `getMessages`/`listSessions` in chat history — so nothing expired comes back during DynamoDB's sweep lag (see [Expiry with TTL](../README.md#expiry-with-ttl) for how long that can take).

**Checkpointer.** A thread whose head expired reads as its newest *live* checkpoint (or as empty); older checkpoints can expire while the head lives, so `parentConfig` may point at a checkpoint that is gone, which LangGraph's resume path does not need; and a swept payload reads as "no checkpoint" only for an already-expired head.

**Chat history.** A single **uniform whole-conversation TTL** sits on the session's metadata row, shared by every message.

- Normally it's set once, at session creation, via `if_not_exists`.
- If the previously-stored anchor is ever found missing or already expired, the next append heals it with a plain overwrite instead of staying stuck. Every message written at any point in time shares whatever the current anchor is; expired messages are also filtered out on read.
- If the append that triggers a stale-anchor heal is itself later rolled back (a later chunk in the same call failed), the healed ttl is not reverted — the session simply keeps the fresher, never-shorter expiry rather than risk regressing a value a concurrent legitimate extension may have since written. This is a deliberate, self-healing tradeoff, not a bug.
- Turning `ttl` on for a chat-history table that already holds sessions stamps the anchor and every *new* message only; message rows written before that keep no `ttl`, outlive their session row, and still come back from `getMessages` — clear those sessions or backfill a `ttl` onto their rows when enabling expiry retroactively.

## Plain (metadata) search

In the store, a `search()` call with no `query` (or with a `query` but no `index`/`vectorBackend` configured) reads rows under the `namespacePrefix` and decodes them `readConcurrency` at a time (default 8) — applying `filter` in-process — until `offset + limit` matching items are in hand, then stops: the page is the complete answer, so a namespace far larger than the page costs neither a full decode nor a `RESULT_TRUNCATED` error.

Only a page that cannot be filled from fewer rows is bounded by `maxScanItems` (default 10,000; exceeding it throws rather than silently returning a partial result). This is a different cap from `maxSearchCandidates` below: `maxScanItems` gates rows read, `maxSearchCandidates` gates the in-DB semantic ranker. For namespaces that routinely exceed the default, prefer a `vectorBackend` or a narrower `namespacePrefix` over raising the cap, which stops at 1,000,000.

A rootless search or listing also walks DynamoDB pages under `maxIterations` (default 1000, `Infinity` for no cap). A table whose rows are mostly not store items — large checkpoints sharing the table, say — can meet this cap long before `maxScanItems` counts enough store rows to matter, since a page of such a table holds few or none; raise `maxIterations` for that table rather than `maxScanItems` alone.

## Semantic search

Give the store an `index` with a LangChain `Embeddings` implementation. On `put`, each extracted text is embedded separately — one vector per text the configured paths extract, as the reference store does — and on `search` with a `query` an item is ranked by its **best-matching** vector, so a long document with one strongly relevant section is found instead of being averaged away. A row written before the per-path change carries a single vector and still ranks exactly as it did.

By default those vectors are stored on the item and ranking happens in-process over the scoped candidate set, bounded by `maxSearchCandidates` (default 1000, ceiling 100,000). Exceeding it throws a `VALIDATION` error as soon as more rows than that exist under the prefix, before any row is decoded or the query embedded, steering you to an external index.

- A `vectorBackend` search that reaches `maxSearchCandidates` while its `filter` has left fewer than `offset + limit` matches throws the same error instead of returning a silently short page.
- A canonical read that fails also fails the search, for the same reason: the in-DynamoDB path and the `vectorBackend` path answer alike under throttling or an outage rather than one of them quietly returning a page one item short.
- Only a match naming an address this store cannot form (a namespace element holding the reserved separator, which `reconcileVectorIndex` repairs) is dropped, with a `warn`.

For large corpora, pass a `vectorBackend`: a **single** vector over the joined fields is sent there instead of the per-path set, similarity search is delegated to it, and DynamoDB still holds the canonical item. Per-item indexing can be overridden via the `index` argument to `put` (`false` to skip, or a `string[]` of fields).

## Vector index consistency

When a `vectorBackend` is configured, **DynamoDB holds the canonical item** and the backend is a rebuildable index. After each canonical write the embedding is synced to the backend best-effort: a failure is logged (not thrown), so a backend hiccup never fails an otherwise-successful `put`/`delete`.

A `delete` additionally confirms the key holds no row — one consistent `PK`-only read — immediately before dropping its vector, and keeps the vector when it finds one, so a put that recreates the item mid-delete, and a delete that resolves with the item still there, both stay searchable; an `info` records it. The confirmation also runs *above* the S3 cleanup rather than after it, so no round trip with its own retries and its own backoff sits inside the window. A put committing in the gap between that read and the backend call is what remains, and it needs a compare-and-swap the `VectorBackend` contract cannot express — a third-party promise no implementation would be obliged to honour. The residue is narrowed twice and still open: the reorder took the window from a whole S3 cleanup down to adjacent statements, and the confirmation took it from *any* put landing in that stretch down to one that commits between the read and the backend call.

**Repairing drift.** Call `store.reconcileVectorIndex(namespacePrefix)`: it re-pushes every live embedding and, when the backend implements the optional `listKeys`, prunes vectors with no canonical item; it returns `{ upserted, pruned }`. Run it when the namespace is idle — that is a precondition, not a hedge. Caveats:

- Reconciliation re-embeds with the store's **configured** index fields, so per-`put` field overrides are not reproduced.
- Prune happens only when `listKeys` is implemented; otherwise reconcile re-pushes only and logs that prune was skipped.
- The prefix must be a non-empty namespace.
- The prune keeps two windows of its own, wider than the delete path's: a candidate the snapshot *saw* but that now yields no indexable text is pruned on that evidence alone, with no confirmation read, so an item re-put with indexable text between the snapshot and the prune loses its vector; and a candidate the snapshot never saw is confirmed gone one statement before the backend call, the same two-statement gap as above.

## Checkpointer semantics

`put()` of an existing `checkpoint_id` is last-writer-wins, as in the reference savers: the transaction is unconditional, so two processes writing the same id keep whichever **committed** last, and the loser's offloaded objects wait for the lifecycle rule. Committed, not landed, and the difference is observable: every `put()` draws a token of its own, so two distinct calls never deduplicate each other, but a *retry* cannot overtake a call that committed after it. A commits, A's acknowledgement is lost, B commits, A retries — A's retry is answered from the idempotency cache and B's checkpoint survives, where a token-less write would instead let A's retry re-land and win.

`putWrites` issues one guarded `PutItem` per write — a one-item `TransactWriteItems` where that write's payload was offloaded — all in parallel, so a `Send` fan-out of a thousand branches is a thousand concurrent writes (fine on on-demand tables; size provisioned capacity accordingly).

`deleteThread()` reads the partition once and deletes what it saw, rows first and then their offloaded objects, with no read in between. A graph still running on the thread can leave fresh rows behind — a write that *starts* after the partition read lands and survives the pass — so call it when the thread is quiescent.

A write that committed *before* that read and whose retry lands after the delete is discarded instead of applied, but only where the write carries a token: `put()`'s two rows always do, and a `putWrites` write does when its payload was offloaded. A `putWrites` write that stayed **inline** is deliberately still a plain `PutItem` — it names no S3 object, so it can strand none, and tokenising a thousand-branch `Send` fan-out would double its write capacity to buy nothing — so that one can still put its row back after the delete: what comes back is an ordinary row rather than one pointing at a deleted object, which is why the cheap shape is the right one there. A delete that fails part-way leaves the objects of its already-deleted rows to the lifecycle rule.

`list()` without a `thread_id` lists every thread in the table: through a table scan, like the reference savers, or through the recency index when `indexName` is set.

## Chat history semantics

Message order is the write order of one adapter instance (its ULIDs are strictly monotonic even within a millisecond); across instances or processes it is the writers' wall clocks at millisecond precision, so a process whose clock lags can sort a later turn before an earlier one.

**Serialization.** The default `serde` is the plain-JSON `JSON_SERDE`: a `Uint8Array`/`Buffer` inside a message (a `ToolMessage.artifact`, say) reads back as an index-keyed object, and so does a `Map` or a `Set`.

For binary fidelity, pass LangGraph's `JsonPlusSerializer` — which **no package exports as a symbol you can import**: `@langchain/langgraph-checkpoint` ships it at `dist/serde/jsonplus`, exports neither it nor its module, and its `exports` map admits only `.` and `./package.json`, so both `import { JsonPlusSerializer } from '@langchain/langgraph-checkpoint'` and any deep path are errors rather than imports.

The supported way to hold the instance is to take it off a saver that already has it, since it is the base class's default: `serde: new MemorySaver().serde`, with `MemorySaver` imported from that package, is a `SerializerProtocol` and is the same serializer `DynamoDBSaver` uses when you pass no `serde`. A `Date` is **not** a reason to reach for it: neither default round-trips one, and both read it back as an ISO string (see [Table schema](../README.md#table-schema)). Keep a `Date` as an ISO string, or an epoch number, in the message yourself.

**Batched appends.** A batch over 99 messages or 3.5 MB is committed in chunks and is atomic from the writer's perspective only: a concurrent reader can see the first chunks before the append settles, and a rolled-back append still bumps the session's `updatedAt`. A failed chunk is read back before anything is rolled back, and one whose outcome cannot be established — its read fails, or some attempt of it may still be applied: it got no answer, or DynamoDB answered that it was still in progress (`TransactionInProgressException`) or failed with a server error (5xx) — keeps its objects and fails the call with `COMPENSATION_FAILED`, or `ABORTED` when the caller cancelled; a cancelled append sends no further chunk. Under heavy contention on one session an append can spend up to about 61 seconds per chunk *sleeping* between retries (18 attempts, 5 s cap), which is about four minutes of wall time per chunk once the attempts themselves are counted at the per-attempt bound (see [Retries and backoff](../README.md#retries-and-backoff)) — and the sleeping is three times as long again when an injected client keeps the SDK's own retries. What a caller sees when one of these chunks fails, and what it should do about it, is under the README's [Error ordering and partial progress](../README.md#error-ordering-and-partial-progress).

`clear()` has the same single-pass, quiescent-session caveat as `deleteThread()`: a message appended while it runs may survive it. Each message's object is keyed by that message's own id, so a new message never shares an object with a row being deleted.

## What each operation costs

Requests per call, before retries. "Consistent" reads are `ConsistentRead: true` (twice the read units of an eventually consistent read); S3 requests apply only to offloaded payloads.

| Operation | DynamoDB | S3 |
| --- | --- | --- |
| `saver.getTuple` | 1 consistent `GetItem` (by id) or `Query` (newest) for the META row — one more `Query` per 50 expired or foreign rows at the head of the namespace, which a `ttl` can leave behind during DynamoDB's sweep lag, since the newest-first read evaluates 50 rows per page and keeps the first live one —, 1 consistent `GetItem` for the payload, 1 consistent `Query` for the pending writes; a pre-v4 checkpoint adds a `Query` of its parent's writes | 1 `GET` per offloaded payload, 8 at a time |
| `saver.put` | 1 `TransactWriteItems` (META + PAYLOAD); after a failed transaction with `s3`, 1 consistent `GetItem` of the row carrying an offloaded descriptor, when something was offloaded | 1 `PUT` per offloaded payload; after a failure that read shows did not commit, 1 `DeleteObjects` of those uploads |
| `saver.putWrites` | 1 `PutItem` per write, all in parallel — a one-item `TransactWriteItems` instead, at twice the write units, for a write whose payload was offloaded — guarded except for a special write without `s3`; with `s3` each special write adds 1 consistent `GetItem` and up to 3 compare-and-swap attempts, then 1 unguarded `PutItem` if all 3 are rejected; with `s3`, each failed `PutItem` adds 1 consistent `GetItem` to learn whether it landed, except a regular write's conditional rejection and a special write's rejection that returned the row | 1 `PUT` per offloaded write, `DELETE` of a superseded special write |
| `saver.list` | 1 eventually consistent `Query` per page; without a `thread_id` a `Scan`, or — with `indexName` — per page of 100 rows 1 `Query` per index shard, `readConcurrency` at a time, and 1 more for a shard each time it has no row buffered while the page still needs one, even if the page then takes none of that query's rows, holding the 100 rows plus at most one DynamoDB page (1 MB) per shard; per yielded tuple 1 `GetItem` and 1 `Query` for its writes | `GET` per offloaded payload and metadata |
| `saver.deleteThread`, `history.clear` | 1 consistent `Query` per page, then 1 `DeleteItem` per row — one request each, because `BatchWriteItem` silently ignores the condition every row is pinned with — at most 8 in flight, issued in batches of 25 | 1 `DeleteObjects` per 1000 keys |
| `store.get` | 1 consistent `GetItem` | 1 `GET` |
| `store.put` | 1 consistent `GetItem` (previous descriptor and revision), 1 `PutItem` (with `s3` guarded: up to 3 attempts under contention, each re-reading from the rejection, then 1 unguarded if all 3 are rejected), sent instead as a one-item `TransactWriteItems` at twice the write units when the payload was offloaded, 1 consistent `GetItem` after a write that fails, to learn whether it landed, plus the `vectorBackend` upsert | 1 `PUT`, then `DELETE` of the superseded object |
| `store.delete` | 1 consistent `GetItem` (the revision to pin on and the descriptor to release); with a row there, 1 `TransactWriteItems` removing it under that pin, up to 3 attempts under contention, each re-pinning from the rejection and none of them deleting if all 3 are rejected; **no write at all when there is no row**; 1 consistent `GetItem` after a write whose budget is spent, to learn whether it landed; and, **only when a `vectorBackend` is configured**, 1 more consistent `GetItem` projecting `PK` alone to confirm the key really holds no row, on every path including the one that had none to begin with, followed by the `vectorBackend` delete when it does not | `DELETE` of the released object |
| `store.search` | 1 eventually consistent `Query` per page (`Scan` for `[]`), decoding rows `readConcurrency` at a time (8 by default) until the page is full; a `query` adds one embedding call | 1 `GET` per offloaded candidate |
| `store.listNamespaces` | `Query` (`Scan` without a prefix root) per page, projected to each item's key and format version | none |
| `history.addMessages` | 1 consistent `GetItem` of the session row when `ttl` is set, then 1 `TransactWriteItems` per chunk (up to 99 messages plus the session update); a rollback costs 1 `BatchWriteItem` per 25 rows plus a session update | 1 `PUT` per offloaded message |
| `history.getMessages` | 1 consistent `Query` per page (newest-first with a page cap under `limit`) | 1 `GET` per offloaded message, 8 at a time |
| `history.listSessions` | 1 `Scan` per page, or — with `indexName` — 1 `Query` per index shard (8 by default), `readConcurrency` at a time, and 1 more for a shard each time it has no row buffered while the page still needs one, even if the page then takes none of that query's rows, holding the page (up to `limit` rows, and `limit` is capped at 10,000) plus at most one DynamoDB page (1 MB) per shard; pageable by cursor | none |
| `history.reconcileMessageCount` | 1 consistent `GetItem` of the stored count, 1 eventually consistent `Query` per page returning only each message's `v` and `ttl`, 1 guarded `UpdateItem`; all three again, up to 3 attempts in all, when the stored count changes while it counts | none |
| `store.reconcileVectorIndex` | 1 `Query` per page, embedding calls in batches, backend upserts and deletes | `GET` per offloaded item |

## Cost in request units: a worked example

DynamoDB charges by the **request unit**, not by the byte, and rounds every item up to a fixed boundary before pricing it: a write unit is one write of up to 1 KB (rounded up), a *transactional* write is 2 write units per KB; a read unit is one strongly consistent read of up to 4 KB (rounded up), an eventually consistent read is half that and a transactional read is twice it ([DynamoDB's own request-unit rules](https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/read-write-operations.html)). Applying those rules to the request shapes in [What each operation costs](#what-each-operation-costs) above turns the table into concrete numbers for four representative calls:

- **`saver.put` of a checkpoint** with a META row of about 1 KB and a serialized PAYLOAD row of 5 KB, both under `thresholdBytes` so nothing offloads to S3. `saver.put` always sends one `TransactWriteItems` carrying both rows, so both round up to the KB and are billed at 2 write units per KB: `2 × (1 + 5)` = **12 write units** — against `1 + 5` = 6 write units for the same two rows as plain (non-transactional) `PutItem`s. That 2× is [what a token costs](#what-a-token-costs) made concrete: every `saver.put` pays it, offloaded or not.
- **`saver.getTuple` of that checkpoint**, which always uses `ConsistentRead: true` ([Strong consistency](../README.md#strong-consistency)). One consistent `GetItem` for META (rounds up to the 4 KB boundary → 1 read unit), one for PAYLOAD (5 KB rounds up to 8 KB → 2 read units), one consistent `Query` for the pending writes (say three rows totalling 3 KB, rounded up to 4 KB → 1 read unit): **4 read units** total. The same three reads eventually consistent would be half that, 2 — but `getTuple` never asks for that.
- **A `history.addMessages` chunk of 20 messages at about 1 KB each** (20 KB of message rows, well under the 99-message/3.5 MB chunk ceiling) plus the session row it updates (about 1 KB): one `TransactWriteItems`, so `2 × (20 + 1)` = **42 write units** for the chunk.
- **`store.get` of a 2 KB item**, consistent: rounds up to the 4 KB boundary, so the read costs **1 read unit** — a consistent read of anything up to 4 KB costs one, whatever fraction of it is used.

What each unit costs in your account — on demand or provisioned — and what an offloaded payload's S3 `PUT`/`GET` and storage cost, are on [DynamoDB pricing](https://aws.amazon.com/dynamodb/pricing/) and [S3 pricing](https://aws.amazon.com/s3/pricing/); this package has no opinion on either, only on how many requests and how many units a call sends.

## Monitoring

Alert on the three `error` events (a corrupt message row, a failed append rollback, an append chunk whose outcome is unknown) and on the five `warn` events that name an orphan or an exhausted compare-and-swap (see [Logging](../README.md#logging)); count `RETRY_EXHAUSTED` and the AWS codes (`THROTTLED`, `SERVICE_UNAVAILABLE`, `ACCESS_DENIED`, …) by `context.operation`, `context.tableName` and `context.httpStatusCode`.

For AWS Support you want the `requestId` of the last failure. A `RETRY_EXHAUSTED` error carries it in `context.requestId`, beside that failure's `awsErrorName` and `httpStatusCode`; the failure itself is the error's `cause`. So does an AWS failure a public method wrapped, and an `S3_OFFLOAD_FAILED` for the S3 failure beneath it. The `debug` retry line names the attempt, the delay and the error's name, but not the `requestId`.

Watch the table's `ThrottledRequests` and `ConsumedWriteCapacityUnits` per partition key prefix — the [hot-partition](../README.md#production-notes) note explains which identifier concentrates load.

## What can still go wrong

A row in DynamoDB and its payload in S3 are two writes with no transaction across them, and the durability of that pair is layered: a compare-and-swap and a request token prevent the losses they can, S3 versioning contains what slips through, and the sweep below finds it. No layer is total. This is the list of what is left, so that none of it is met as a surprise. None of these is a known defect — each is a deliberate limit, with what backstops it.

- **A write that outlives the token window.** DynamoDB honours a token for ten minutes and a tokened write stops starting attempts at 300 s, so reaching the window takes an injected client with no request timeout of its own, or a clock that jumps backwards. Past it a re-send is a new request and is applied, which can put a row back naming an object something else released. On a versioned bucket the payload is still there for the grace window, so the row is restorable and the sweep below finds it.
- **A strand older than the grace window.** Once S3 has reclaimed the noncurrent version and then the delete marker, there is no marker to list and no backlink to read. The sweep is blind to it by construction; the table-scan recipe below is the only way to find one.
- **An inline write can still re-land.** An inline `store.put` or `putWrites` whose acknowledgement is lost can put back a row a concurrent delete removed, because inline writes carry no token on purpose. The row simply comes back: it names no S3 object, so no read fails. An offloaded write in the same interleaving lets the delete stand — the two differ by where `s3.thresholdBytes` falls, and a caller who wants them uniform sets it low.
- **Versioning off, or suspended.** The containment layer is then absent and the guarantee is the prevention layer's alone, bounded by those ten minutes. `ensureS3LifecycleRule()` warns and carries on; nothing enforces it, and nothing tells a caller at read time.
- **Transaction conflicts on a contended row are ordinary, not pathological.** On an offloaded write path a `TransactionCanceledException` whose reason is `TransactionConflict` replaces what would have been a clean win-or-lose, at the rates under [What a token costs](#what-a-token-costs) above. The retry budget absorbs them — at the widest race measured, 60 logical writes produced 60 clean outcomes and no exhaustion — so the residual is cost, not correctness. Exhaustion stays possible in principle under contention heavier than that.
- **A retryable error on the inline paths that plain `PutItem` writes never saw before `0.9.0`.** Because an inline write stays a `PutItem` while an offloaded write to the same row is a transaction, an inline write can meet a bare `TransactionConflictException`: 18% of the inline side's attempts under ten-against-ten contention on one row. It is retryable by name, so it costs requests rather than correctness — but it is a behaviour change on a path that is otherwise untouched, and it is the price of deciding by payload rather than by adapter.
- **The store's unconditional fallback is still unconditional.** When `store.put`'s compare-and-swap budget is spent it overwrites with no guard at all and logs a `warn`. A token stops that put's own retries re-landing it *when the payload was offloaded*, and nothing does when it was inline; nothing at all stops it overwriting what a racer committed in the meantime, and the object it then releases is whatever its last observation named. Unchanged behaviour, listed here so that "the overwrite race is closed" is not read as "the store put has no unguarded write left".
- **`deleteThread()` and `clear()` are still single-pass.** A write that starts after the partition read lands and survives the pass; only the re-landing of a write that committed *before* the read is prevented, and only where that write carries a token.
- **Leaks are unchanged.** Every orphan case listed under [S3 offloading](#s3-offloading) — an exhausted compare-and-swap, a best-effort delete that genuinely fails, a write that cannot be verified — still leaves an object behind, and `ensureS3LifecycleRule()` is still what reclaims it.
- **A write cut short keeps its uploads.** A write the caller's signal, the request timeout or a dropped connection ended before DynamoDB answered may still be applied after the call returns, so its uploaded objects are kept instead of released (decision record 25). Where no row ends up naming them they are orphans, reclaimed by the lifecycle rule when a `ttl` is set. An append cancelled while a chunk was in flight may leave that chunk's messages in the session: read it back before re-sending them.
- **Some rows written before `1.0.0-rc.2` carry no per-write id.** A partition delete pins each row on the id the read observed of it, and a row carrying none is deleted unconditionally, exactly as every row was before. It affects the rows whose id arrived in `1.0.0-rc.2` — a checkpoint's `META` and `PAYLOAD` rows, a history message row and the history `SESSION` row — and not pending-write rows, which have carried `writeGroup` since `0.8.0`. It drains rather than needing a migration: a row gets an id the next time it is written, and a table started on `1.0.0-rc.2` or later has none missing.
- **A partition delete can split a checkpoint from its pending writes.** The two are written by different calls under different ids, so a refusal on one side leaves the other deletable: pending writes can outlive their checkpoint.
  - The reverse — a checkpoint that loses its acknowledged `putWrites` output — is closed, because a refused checkpoint row makes the pass skip the rest of that checkpoint's rows. Closing the open direction would need the refusal known before any of the unit's deletes went out, and no ordering gives that: deleting pending writes first only swaps which direction closes.
  - Orphaned pending writes are unreachable while their `META` row is gone — every read path starts there — with one exception: a surviving pre-v4 checkpoint whose `parentCheckpointId` names them still reads their `TASKS`-channel entries back as its own pending sends. They become reachable again if a later `saver.put` writes that checkpoint id, which serves them as that checkpoint's completed task results.
  - What is left is reported — every row the pass leaves in place is logged at `warn` with its sort key, **one line per row and not one per checkpoint**, so a wide unit costs as many lines as it has rows — and a second call clears it.
- **A partition delete can leave a payload row whose metadata row is gone.** This is the third shape, and the split above does not describe it: a racing `saver.put` cannot cause it, because both rows go out in one transaction and nothing else writes a payload row. A delete that **fails** rather than being refused ends the pass with the metadata row already removed, and DynamoDB's own TTL sweep produces the same shape transiently while it works through a thread. Both predate the per-write-id delete guard (`1.0.0-rc.2`) and both are a **leak, not data loss** — every read path starts from the metadata row, so nothing serves the orphan — and both clear on a re-run.
- **`store.delete` can resolve without deleting.** Three writers landing at the item between a re-pin and its attempt exhaust the compare-and-swap; the item stays, nothing is released — correctly, a live row names it — and the call reports success with one `warn`.
- **`store.delete` cannot be cancelled, and its pre-read is not bounded by the write lifetime.** The call takes no `AbortSignal`, and the deadline covers only the writes that carry a token, so the pre-read keeps the full configured retry budget on top of the three bounded transactions: about three and a half minutes at the defaults, hours at the ceilings `retry` accepts, with nothing able to interrupt it.
- **A vector can still be dropped for a live item.** The window is two statements wide — a put that commits between the confirmation read and the backend call — and `store.reconcileVectorIndex()` is the repair, as [Vector index consistency](#vector-index-consistency) above describes.

Two of the things this list rests on are **deliberate design choices, not leftover gaps**, and they are the two most worth reading twice: what a token does and does not promise ([What a token guarantees, and what it does not](#what-a-token-guarantees-and-what-it-does-not)), and the 300 s cut on a write's retry budget ([Retries and backoff](../README.md#retries-and-backoff)).

## Finding rows whose payload was released

On a versioned bucket a released payload is not erased: it becomes a noncurrent version behind a delete marker, and it stays there for the grace window the [lifecycle rules](../README.md#s3-lifecycle-rules) set. That window is the only cheap opportunity to find a **stranded row** — one that is still live and still names an object whose payload has been released — because the object side lists exactly the releases, and every offloaded object carries its row's key as S3 user metadata (`dynamodb-pk-b64`, `dynamodb-sk-b64`).

The sweep that does this lives at `scripts/find-stranded-payloads.mjs` **in the repository**. It is deliberately not in the npm tarball and there is no `bin` for it: its command line would otherwise become a `1.x` compatibility promise for a tool an operator runs a handful of times. Clone the repository (or copy the one file) to run it:

```bash
node scripts/find-stranded-payloads.mjs \
  --bucket my-bucket --table my-table --region eu-west-1 \
  --prefix langgraph-checkpoints/ --grace-days 1
```

`--prefix` defaults to `langgraph-checkpoints/` and `--grace-days` to `1`, the grace `ensureS3LifecycleRule()` writes; pass the larger number when the bucket carries a longer `NoncurrentDays` floor, so the hours-remaining figure is not pessimistic. The script prints the settings it swept with, so a report pasted into an incident channel says what it ran against. It **exits 0 whenever the sweep completed**, found something or not, and non-zero only when the sweep itself failed — so anything you wire it into should alert on the report, not on the exit code.

**Permissions are the operator's, not the library's.** The sweep needs `s3:ListBucketVersions` and `s3:GetObjectVersion` on the bucket and `dynamodb:GetItem` on the table. The first two are actions this library never calls, which is why they are absent from the policy under [IAM permissions](../README.md#iam-permissions): grant them to whoever runs the sweep, not to the role your application runs as.

**When to run it.** On demand: after an incident, or when `S3_OFFLOAD_FAILED` or a `NoSuchKey` read failure starts alarming, or an `AccessDenied` one on a role without `s3:ListBucket`. Not hourly — not for what it costs in money, which is about a cent (below), but for the requests it puts on a live table and bucket. It costs per release, not per query, and the numbers below are per sweep.

**What it reads, in order.** `ListObjectVersions` under the prefix, paginated; for each released key, `HeadObject` on the **surviving payload version** to read the backlink; then a strongly consistent `GetItem` on the decoded key. A key counts as released only when its **current** version is a delete marker: one written again after a release carries its marker further down its history, its payload is current and readable, and it costs the sweep no request at all. It reports a row that is live and still names that key. A row that is gone is the ordinary release — on the happy path that is every marker — and a row that now names a different object was superseded, not stranded; neither is reported. Each finding prints the DynamoDB key, the object key, the payload version's id, the delete marker's id and timestamp, and the hours of grace remaining.

An object whose backlink cannot be read, and a row DynamoDB will not hand back, are each printed as one `UNREADABLE` line naming the object key and the reason, and the sweep carries on: one 404, one object written by something else, and one throttled read must not cost you the rest of the report.

**What it costs.** Per sweep, with `V` versions and `M` delete markers under the prefix:

| | requests |
| --- | --- |
| listing | `ceil((V + M) / 1000)` — `ListObjectVersions` returns at most 1000 entries per page, counting versions and markers together |
| per marker | 1 `HeadObject` + 1 `GetItem` |
| total | `ceil((V + M) / 1000) + 2M` |

With the marker-reclaim rule on the bucket, `M` is the releases still inside the grace window — roughly one to two days of release volume — and `V` is the live payload count plus the same. A deployment releasing 10 000 payloads a day with 100 000 live offloaded objects therefore has `V = 120 000` (100 000 live plus 20 000 not-yet-expired noncurrent) and `M = 20 000`, so one sweep costs `ceil(140 000 / 1000) + 2 x 20 000` = **40 140 requests**, dominated by the per-marker pair. At on-demand prices that is **one to two cents**, not a few dollars: 20 000 `HeadObject` at $0.0004 per 1 000 is $0.008, 140 `ListObjectVersions` at $0.005 per 1 000 is $0.0007, and 20 000 strongly-consistent `GetItem` on small items is 20 000 read request units, about $0.0025. So money is not the reason to run this on demand rather than hourly. The reason is the 40 000 requests themselves, against a live table and bucket, most of them strongly-consistent reads on rows a running graph is using.

**Without the marker-reclaim rule, `M` is total lifetime release volume** and the figure above has no upper bound: every release leaves a marker that is never reclaimed, so the sweep's cost grows for the life of the bucket. Two deployments do not get that rule from this library:

- **`s3` configured without a `ttl`.** `ensureS3LifecycleRule()` is a no-op in that shape, so a versioned bucket accumulates a delete marker per release forever.
- **Anyone who never calls `ensureS3LifecycleRule()` at all.**

Both must write the two rules themselves; the README gives [their shapes](../README.md#s3-lifecycle-rules) verbatim.

The cost grows with that listing; the memory does not. `ListObjectVersions` answers in ascending key order, so every entry for one object key arrives together and the sweep joins a key the moment a later one appears — it holds one key at a time, never the listing. That is what lets it finish on the bucket described above, which is the one you are most likely to sweep after an incident. It also checks that order rather than assuming it: a key listed after a later key has already been joined fails the sweep with a non-zero exit instead of reporting a join it cannot stand behind.

**What it cannot find.** A strand whose grace window has already expired. S3 reclaims the noncurrent version first and then the delete marker, so there is neither a marker to list nor a backlink to read, and the sweep is blind to it by construction. Finding those needs the opposite direction — a full table `Scan`, keeping every row that carries an offloaded descriptor, then one `HeadObject` per descriptor to see whether the object is still there — which costs a read of the whole table and stays a recipe rather than a script. While the marker is still present but its last version has gone, the sweep counts the key separately as having no surviving payload version, which is the last warning you get. Read that count as an upper bound on expired grace windows rather than a list of them: a bare delete marker is also what a `DeleteObject` on a key that never existed leaves, and what any foreign delete under the prefix leaves.

**What to do with a finding.** The script repairs nothing, and it should not: the right remedy depends on why the row is there. Either **restore the payload** — `DeleteObjectVersion` on the *delete marker's* version id, which makes the payload current again, and which only works while the hours remaining are positive — or **accept the delete** — `DeleteItem` on the DynamoDB key. For a checkpointer `WRITE` row that survived a `deleteThread()`, deleting the row is right; for a store item recreated after its object was released, it is not.

## Lambda and other short-lived runtimes

Construct the adapters once at module scope (or one `DynamoDBFactory.createAll()`), reuse them across invocations, and pass a `client` you own if the function also uses DynamoDB elsewhere; `destroy()` is only needed when a process wants to release sockets before exit. Size the function timeout against the worst-case retry budgets above: a heavily contended chat append spends about a minute sleeping and can take about four with its attempts, and `retry.maxAttempts` / `retry.maxDelayMs` trade that ceiling against resilience to throttling. Every long-running method takes an `AbortSignal`, so a timeout can cancel cleanly (see [Cancellation](../README.md#cancellation)).

## The on-disk layout

Every `1.x` release reads every row a `1.0` release wrote. New attributes may be added in a minor; they are optional, and a row without them keeps its `1.0` meaning. The key formats, the required attributes and the payload descriptor change only in a major, with a migration note.

| Adapter | Partition key | Sort keys | Attributes |
| --- | --- | --- | --- |
| Checkpointer | `CHKPT#<thread_id>` | `META#<ns>#<checkpoint_id>`, `PAYLOAD#<ns>#<checkpoint_id>`, `WRITE#<ns>#<checkpoint_id>#<task>#<idx>#<channel>` | META: `threadId`, `checkpointNs`, `checkpointId`, `metadata`, `v`, optional `parentCheckpointId`, `gsi1pk`, `gsi1sk`, `ttl`; PAYLOAD: `checkpoint`, `v`, optional `ttl`; WRITE: `taskId`, `index`, `channel`, `writeGroup`, `value`, `v`, optional `occurrence`, `ttl` |
| Store | `STORE#<namespace[0]>` | `<namespace[1..]>#<key>` | `namespace`, `key`, `value`, `createdAt`, `updatedAt`, `v`, optional `embeddings`, `embedding`, `rev`, `ttl` |
| Chat history | `HIST#<sessionId>` | `HISTORY#SESSION`, `HISTORY#MSG#<ULID>` | session: `sessionId`, `messageCount`, `createdAt`, `updatedAt`, `v`, `writeId` (the id of the append that last wrote the row; rows last written before `1.0.0-rc.2` carry none), optional `title`, `gsi1pk`, `gsi1sk`, `ttl`; message: `sessionId`, `message`, `v`, optional `ttl` |

`gsi1pk`/`gsi1sk` are the [recency-index](../README.md#table-schema) keys of checkpoint `META` and history `SESSION` rows; they are written whether or not a table defines the index, so enabling `indexName` later needs only a backfill. A store row `1.0.0-rc.2` wrote may carry them too; they are ignored and dropped by the next put of that item. `embeddings` holds one vector per extracted text; `embedding` is the single joined vector older rows carry and is still read. `storedChannels` was written by `1.0.0-rc.1` and no longer is: it is ignored on read and rows carrying it keep their meaning.

Offloaded objects live at `<keyPrefix><base64url(part)/...>/<write id>.bin` — the parts identify the row that points at the object (for a history message, its session), and the last segment, not encoded, is the id of the write that uploaded it: a UUID for a store put, a ULID for a checkpoint put, a `putWrites` call or a history message. Each object also carries its row's key as S3 user metadata (`dynamodb-pk-b64`, `dynamodb-sk-b64`), the backlink AWS recommends for cleaning up orphans, and the lifecycle rule id is `langgraph-ttl-<slug of keyPrefix>`. All three are stable for `1.x`. Objects written by `1.0.0-rc.1`, whose last segment was the same kind of id base64url-encoded, are still read and deleted exactly as before — a descriptor always records the full key, so nothing needs migrating.

The `ttl` attribute is Unix epoch seconds; compression is gzip; `serdeType` records the tag the writing serializer returned and is handed back to the **configured** serializer's `loadsTyped` on read — it names a format to that serializer, it does not select one. Nothing on the row selects a serializer, and both defaults tag their bytes `"json"` for every value but a raw `Uint8Array`, which `JsonPlusSerializer` alone writes and tags `"bytes"`, so changing an adapter's `serde` changes how its existing rows read (see [Trust boundary](../README.md#trust-boundary)).

## Errors, logs and row versions

Every row carries `v`, its format version. A reader treats a row without `v` as version 0 and reads it under the rules that applied when it was written; a row whose `v` is higher than the reader understands fails with `FORMAT_UNSUPPORTED`, on every read that returns a row's content, rather than being read as though its unknown attributes did not matter. A minor may raise the version it writes only in a way older `1.x` readers still accept. A payload descriptor carries its own `schemaVersion` under the same rule and is read the same way: a forward one fails with `FORMAT_UNSUPPORTED` naming `schemaVersion` rather than `v`, on every read that returns a payload's content.

`ErrorCode` values are append-only in `1.x`; there is one error class, `ErrorContext` only gains fields, and the `details` shape of a code only gains fields. Error *messages* and log *messages* are not covered — branch on `code` and the structured fields, never on text.

**Text this library did not length-check is cut before it is quoted**, in a log line and in an error message alike: at 256 characters for a string and at 8 labels for a namespace or channel list, each marked `…(len N)` with what it really held. That covers a row's own attributes, an S3 object key, `s3.bucketName`, a `namespacePrefix` (checked label by label, never for how many labels), a failure's `name` wherever a line or a message quotes it, and a value off an object you passed in. Identifiers this library validated go in whole — a `sessionId`, a `threadId`, a `namespace` and `key` pair, and any key built from them are capped before a request is made. The structured `context` on an error is **not** cut, so what you branch on or log as data still carries the value in full.

**A relayed cause's own text takes a larger cap: 1024 characters.** Whenever an error of this library quotes what failed underneath it — an AWS SDK error a public method wraps, the last failure inside a `RETRY_EXHAUSTED` error, an S3 transfer failure, a `COMPENSATION_FAILED` error, or whatever your `serde` or `vectorBackend` threw — that text is redacted and then cut at 1024, marked the same way. It is prose rather than an identifier: an IAM `AccessDenied` naming a principal ARN, an action and a resource ARN runs to several hundred characters and is the one diagnostic worth reading in full, while an error thrown by your own collaborator is as long as you make it and is quoted once per row on reads that walk a whole prefix or table.

The cause itself is attached as `err.cause` and keeps its message whole; only the quoted copy is cut. One option key is deliberately left alone: the `options.<key>` an unknown-option `VALIDATION` names is also its `context.field`, and `context.field` is not cut, so cutting the message would make the two disagree.

## Differences from the reference implementations

`MemorySaver` and `InMemoryStore` are the behaviour this package matches. Every observable difference is listed here; anything not in this table is a defect, not a choice, and the differential tests are what enforce that. From `1.0.0`, adding a row is a **minor** at most, and only when the reference itself is the defect or this package's storage and key rules require the difference; changing one a caller may already rely on is a **major**.

| # | Difference | Kept because |
| --- | --- | --- |
| V-1 | Write identity is `(taskId, channel, occurrence)` | index positions are unstable across a retry; kept unobservable by read-side dedup |
| V-2 | Namespace prefixes match element-wise | the reference compares the joined string, so `['users']` matches `['userspace']` |
| V-3 | Namespace elements may not contain `#` | the separator is structural in the sort key |
| V-4 | A namespace whose items are all deleted stops being listed | the reference retains an empty namespace with no row behind it |
| V-5 | `search` / `listNamespaces` raise `RESULT_TRUNCATED` past `maxScanItems` or `maxIterations` | silently truncating a result set is worse than refusing it |
| V-6 | Re-putting with `index: false` clears the stored vector | the reference keeps a stale vector for a changed value |
| V-8 | A value JSON refuses (circular, `BigInt`) yields no index text instead of throwing from inside text extraction | the put is refused a moment later by the codec, with a `VALIDATION` error naming `value` rather than a raw `TypeError` from the embedding step |
| V-9 | Namespaces the collation calls equal are ordered by code unit | the reference leaves that pair to insertion order, which here is DynamoDB's read order, so a page boundary could fall between them differently on two calls |
| V-10 | `put` stores every channel value, never only the ones `newVersions` names | narrowing stored *nothing* when LangGraph forks a checkpoint or writes an empty update, both of which pass an empty `newVersions`. `MemorySaver.put` takes no `newVersions` either, and LangChain's validation suite exempts its own `MemorySaver`, MongoDB and SQLite savers from the delta test on the same grounds; the exemption is keyed on a module-name list, so `test/conformance/validation.conformance.test.ts` applies it by name |
| V-11 | `$gt`/`$gte`/`$lt`/`$lte` compare like types only | the reference reduces both sides with `Number()`, which makes every comparison between two ISO-8601 date strings `NaN`-false; native `>` instead coerces, so a stored `'10'` satisfied `{ $gt: 5 }`. Comparing like types directly is well-defined in both cases |
| V-12 | An array used as a field condition is compared as a literal | upstream reaches `Object.keys([]).every(...)`, so `[]` as a condition matches everything there; comparing the stored array is the answer a caller means |
| V-13 | `search` results come back in key order, not insertion order | the sort key is the order DynamoDB reads a partition in, and paging has to be stable across calls |
| V-14 | `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory` refuse a `config` that is not an object, and a `configurable` in it that is present but is not an object, `null` included | the reference crashes on `null` or `undefined`, and reads any other value as a config naming no thread, so `list('x')` lists every thread and `getTuple('x')` answers `undefined`. It reads a `configurable` of `'thread-1'` or `null` the same way: `list({ configurable: 'thread-1' })` lists every thread too, `getTuple` answers `undefined`, and `put` and `putWrites` report a missing `thread_id` |
| V-15 | A checkpoint id of `0`, `false` or `NaN` is refused, whether it arrives as `checkpoint_id`, as `thread_ts` or as `list`'s `before` bound; only `undefined`, `null` and `''` mean no id | the reference tests the id for truthiness, so a falsy one silently addresses the latest checkpoint, or drops the `before` bound |
| V-16 | `list` refuses an `options`, `before` or `filter` that is not an object or is an array, an option key it does not read, and a `limit` of `null`; `before: {}` stays legal | the reference ignores a misspelt key, reads a non-object `options` or `before`, or a `null` filter, as absent, and walks a string or array filter as field names, so the listing comes back silently empty; it also compares `limit: null` as `null <= 0`, which is true, so that listing is empty as well |
| V-17 | `put` refuses a `null` or `undefined` checkpoint, and `putWrites` refuses `writes` that is not an array of arrays, before anything is written | the reference crashes on both; it reads a string entry as a `[channel, value]` pair (`'ab'` writes `'b'` to channel `'a'`), and stores the entries beside a non-iterable one before it rejects |
| V-18 | `getDeltaChannelHistory` requires exactly `{ config, channels }`, with `channels` an array of strings | the reference crashes on a missing argument or `channels`, ignores an extra key, and iterates a string `channels` one character at a time, so `'ab'` answers for channels `'a'` and `'b'` |
| V-19 | `put()` refuses a `null` value; `delete()`, and a `batch()` put operation carrying `null`, still delete | `BaseStore.put` is typed to take an object, yet the reference passes `null` on as the delete operation, so a call named `put` silently removes the item |
| V-20 | A put value that is not an object or is an array, and an `index` other than absent, `false` or an array of strings, are refused on every route, `batch()` included | the reference stores any value, so the characters of a stored string answer a filter as fields (`{ 0: 'a' }` matches `'abc'`), and so do the elements and the `length` of a stored array (after `put(['a'], 'k', ['x', 'y'])`, `search(['a'], { filter: { 0: 'x' } })` and `{ filter: { length: 2 } }` each return the item); it ignores a malformed `index` when no embeddings are configured and crashes on a non-array one when they are, embeds the whole value for a number path, and reads `null` as the configured fields |
| V-21 | `search` refuses a `namespacePrefix` that is not an array, `options` that is not an object, an option key it does not read, a `filter` that is not an object or is an array, a `query` that is not a string, and an `offset` or `limit` of `null`; a `batch()` search operation refuses the same `namespacePrefix`, `offset` and `limit` | the reference throws a bare `TypeError` (`op.namespacePrefix.join is not a function`) for a `namespacePrefix` that is not an array, from `search` and from `batch()` alike; it crashes on `null` options, reads string options as none and ignores a misspelt key; it walks a string or array filter as field names, so the page is silently empty, reads a `null` filter as none, and ignores a non-string `query` when no index is configured; and it reads an `offset` or `limit` of `null` as its default, 0 or 10, on both routes |
| V-22 | `listNamespaces` refuses `options` that is not an object, an option key it does not read, a `prefix` or `suffix` that is not an array, and a `limit` or `offset` of `null` | the reference crashes on `null` options and on a string path, ignores a misspelt key, and reads string options, or a `null` or empty-string path, as none, listing every namespace; it also reads `limit: null` as no limit, listing every namespace, and `offset: null` as 0 |
| V-23 | A search prefix label, or a listing prefix or suffix label, that is not a non-empty string is refused; `'*'` stays a listing wildcard | the reference stringifies a non-string search label (`[1]` finds namespace `['1']`) and matches every namespace for an empty one, while a listing never matches either and answers with a silently empty list |
| V-24 | `batch` refuses an `operations` value that is not an array, and an operation or match condition that is not an object | the reference crashes on most of these and answers the rest wrongly: an `operations` object returns `[]`, an array operation is skipped without a result, shifting every later result, and a numeric `matchConditions` lists every namespace |
| V-25 | `$eq`, `$ne`, `$in`, `$nin` and a plain field condition compare by deep equality | the reference compares with `===`, so an object- or array-valued field never equals a condition, even an identical one: `$eq` and `$in` silently match nothing and `$ne` and `$nin` match everything |
| V-26 | Beyond V-3 and V-23, every store namespace label, item key and search or listing prefix label, and every checkpointer identifier — `thread_id`, `checkpoint_ns`, a given `checkpoint_id` or `thread_ts`, `taskId`, a pending-write channel and `list`'s `before` id — follows this package's identifier rules: no `#`, no control character, no unpaired surrogate, at most 256 bytes of UTF-8 (1024 for `thread_id`, 512 for `checkpoint_ns`), and not blank, except that `checkpoint_ns` may be empty or blank; the sort key a store item or a pending write composes from them is also held to 1024 bytes. The reference stores and finds any such value. An item's namespace must also hold at least one label on every route that addresses an item — `get`, `delete` and a `batch()` put or get as well as `put()` — where the reference refuses an empty namespace in `put()` alone | each of these values is, or is matched against, a segment of a DynamoDB key, and these are the rules a key segment follows here: `#` separates segments, the byte caps keep a composed key within DynamoDB's limits of 2048 bytes for a partition key and 1024 for a sort key, an unpaired surrogate would let two ids encode to one key, and a control character would reach this package's log lines unneutralised. A value outside the rules can never be stored, so a lookup, search or listing naming one is refused rather than answered empty. A store item's partition key is its namespace's first label, so an empty namespace addresses no partition; the reference answers `get([], key)` with `null`, stores a `batch()` put under `[]`, which `listNamespaces` then reports as `['']`, and reads it back and deletes it |
| V-27 | The store's `index` option must be an object naming only `dims`, `embeddings` and `fields`, with `embeddings` providing `embedQuery` and `embedDocuments` and `fields`, when given, an array of strings; `null` is refused rather than read as no index | the reference ignores a misspelt key, so `{ feilds: ['title'] }` embeds the whole document; reads an `index` without `embeddings`, or a `null` or string one, as no index and answers every query unranked; fails at the first put when `embeddings` lacks `embedDocuments`; and crashes at construction on a string `fields` |
| V-28 | A signal that is not an `AbortSignal` — an object with a boolean `aborted` and callable `addEventListener` and `removeEventListener` — is refused with `VALIDATION` naming `signal`, before any request: as `config.signal` to `getTuple`, `list`, `put`, `putWrites` and `getDeltaChannelHistory`, and as the `signal` option of `search` and `deleteThread` | the reference never reads a signal: `MemorySaver` ignores `config.signal`, so `getTuple` with `signal: {}` answers as if none were given, `InMemoryStore.search` ignores a `signal` option, and `MemorySaver.deleteThread` takes no options. Here the wait before a retry calls the signal's `addEventListener` and `removeEventListener`, so a malformed one would otherwise fail partway through a call, after a throttled request and from inside a timer, while a call that is never retried would read only its `aborted` and ignore it silently; either way the option would go unnamed |
| V-29 | `store.delete()` can resolve with the item still there | the row is removed under a condition pinning the revision the call's own read observed, and three attempts in a row, each turned away by a write that landed since the observation that attempt pinned, exhaust the bounded compare-and-swap, so the call resolves, releases nothing and logs one `warn`. The reference holds a map and has no such race, so it always removes the item. Throwing would add a failure mode to an interleaving that succeeds today, which every caller deleting in a `finally` would have to handle, and falling back to an unconditional delete would erase the write that won. Re-run once the key is idle |
| V-30 | Namespaces are ordered by a collation pinned to the `en` locale, not by the host's | the reference sorts with bare `localeCompare`, which means "in the host's default locale", and locales disagree — `'ä'` sorts before `'z'` in German and after it in Swedish. `listNamespaces` pages by `offset`, an index into that sorted listing which the caller holds between two calls, so two hosts answering the same paged listing cut it in two different places and the caller misses one namespace and sees another twice. Parity with the reference was only ever parity on the same host, because the reference's own order varies too; pinning keeps it on every host whose locale agrees and makes the order deterministic on the rest. `en` is pinned because ICU applies no tailoring to it, and it is the one locale a Node built with small ICU still carries |

V-7 was withdrawn in 1.0.0-rc.2: it recorded `store.batch()` answering a put or a delete operation with `undefined` where the reference `InMemoryStore` answers `null`, kept for being "cosmetic" — a reason neither of the two this table allows a row for, the reference being the defect or this package's storage and key rules requiring the difference. That made the row describe a defect rather than a choice, so `batch()` was changed to answer `null` for both, matching the reference, and the row was deleted. The number stays unused.
