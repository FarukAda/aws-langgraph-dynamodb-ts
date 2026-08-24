# Bug Mitigation Plan Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 15 independently-verified correctness/design bugs found in a full-codebase review of `@farukada/aws-langgraph-dynamodb-ts`, in priority order, each with a regression test proving the fix.

**Architecture:** No architectural changes. Every fix is local to the file(s) that own the bug, following patterns already established elsewhere in this codebase (e.g. `deleteThread`'s buffer/flush pagination, `putCheckpoint`'s conditional-write idiom, `cleanUpS3Orphans`'s best-effort cleanup).

**Tech Stack:** TypeScript, AWS SDK v3 (`@aws-sdk/lib-dynamodb`, `@aws-sdk/client-s3`), Jest, `aws-sdk-client-mock`.

**Spec:** This plan's "spec" is the verified findings themselves — each task states the confirmed bug, its evidence, and the researched mitigation inline (there is no separate spec document). All findings were independently re-verified against current source (not assumed from a prior pass) and, where relevant, cross-checked against the official `langchain-ai/langgraph`/`langgraphjs` reference implementations on GitHub and current AWS documentation — not from training-data memory.

## Global Constraints

- **Never run Stryker / mutation testing** — forbidden on this machine (CPU-heavy, blocked by hook).
- **Ask before any CPU/RAM-heavy command**; never run heavy commands in parallel.
- **Never commit or push without being asked.** This plan only prepares working-tree changes; committing/pushing is a separate, explicit step the user controls.
- **This is a published npm package with real users and real S3-persisted data.** Every fix below was checked for backward-compatibility/migration impact; where a fix has ANY blast radius on existing deployed data, that is called out explicitly in the task — do not deviate from the documented approach without re-checking that impact.
- Existing tests must keep passing (`npm run typecheck && npm run lint && npm run build && npm test`) after every task.
- Follow existing codebase conventions: `withDynamoDBRetry`/`withRetry` around AWS calls, `ErrorCode`-tagged errors via `ValidationError`/`wrapError`, `SILENT_LOGGER` in tests, `createStrictDocumentMock()` from `test/shared/helpers/ddb-mock` for DynamoDB mocks, `mockClient(S3Client)` from `aws-sdk-client-mock` for S3 mocks.

---

## Task 1: Fix S3 key collision from unescaped path separators

**Severity:** Critical — silent cross-item data corruption, reachable via the public API.

**Confirmed bug:** `buildS3Key` (`src/shared/codec/s3/config.ts:15-17`) joins `parts` with a bare `/`. Namespace/key/threadId/checkpointNs/taskId strings are only validated to reject `#` (the DynamoDB key separator), never `/`. Two different logical items (e.g. `namespace=["a/b"], key="c"` vs `namespace=["a"], key="b/c"`) can therefore compute the *same* S3 key, so the second write silently overwrites the first, and reads return the wrong item's bytes. Confirmed exploitable via the store (`src/store/internal/item-mapper.ts:41`), the checkpointer (`src/checkpointer/internal/item-writer.ts` — `threadId`/`checkpointNs`/`checkpointId`/`taskId` are validated the same "only `#` forbidden" way), and chat history (`src/history/internal/item-mapper.ts` — `sessionId` has **no dedicated validation module at all**, the most exposed of the three).

**Chosen mitigation:** escape, don't reject. Rejecting `/` in namespace/key would be a breaking API change for any existing user who already uses `/` in a namespace or key today. Instead, base64url-encode each part before joining — base64url's output alphabet (`A-Za-z0-9-_`) never contains `/`, so distinct `parts` arrays can never collide regardless of what characters the caller uses.

**Zero data-migration risk:** confirmed via re-verification that `decodePayload` (`src/shared/codec/codec.ts`) reads the `s3Key` string stored verbatim in each item's `PayloadDescriptor` — it never recomputes the key from `namespace`/`key` on read. So existing S3 objects, written under the old raw-join scheme, remain readable forever; only *new* writes compute keys the new way. Old and new key formats coexist safely in the same bucket indefinitely.

**Files:**
- Modify: `src/shared/codec/s3/config.ts`
- Test: `test/unit/shared/codec/s3/config.test.ts` (existing test needs updating — its expected output will change)
- Test: `test/unit/shared/codec/s3/offloader.test.ts` (existing "buildKey" test needs updating too)

**Interfaces:**
- `buildS3Key(prefix: string, parts: readonly string[]): string` — signature unchanged, only its internal encoding changes.

- [ ] **Step 1: Update the existing tests to expect base64url-encoded segments (red)**

In `test/unit/shared/codec/s3/config.test.ts`, replace the existing `buildS3Key` test:

```ts
import { buildLifecycleRuleId, buildS3Key } from '../../../../../src/shared/codec/s3/config';

describe('buildS3Key', () => {
  it('base64url-encodes each part before joining under the prefix', () => {
    const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
    expect(buildS3Key('langgraph/', ['thread1', 'ckpt1', 'checkpoint'])).toBe(
      `langgraph/${encode('thread1')}/${encode('ckpt1')}/${encode('checkpoint')}.bin`,
    );
  });

  it('never collides two different part arrays that would join to the same raw string', () => {
    const keyA = buildS3Key('p/', ['a/b', 'c']);
    const keyB = buildS3Key('p/', ['a', 'b/c']);
    expect(keyA).not.toBe(keyB);
  });

  it('never collides on separator characters other than "/" either', () => {
    const keyA = buildS3Key('p/', ['a#b', 'c']);
    const keyB = buildS3Key('p/', ['a', 'b', 'c']);
    expect(keyA).not.toBe(keyB);
  });
});
```

In `test/unit/shared/codec/s3/offloader.test.ts`, update the `buildKey` test similarly:

```ts
it('buildKey base64url-encodes parts under the default prefix and getKeyPrefix returns it', () => {
  const { offloader } = makeOffloader();
  const encode = (s: string) => Buffer.from(s, 'utf8').toString('base64url');
  expect(offloader.buildKey(['t', 'c', 'checkpoint'])).toBe(
    `langgraph-checkpoints/${encode('t')}/${encode('c')}/${encode('checkpoint')}.bin`,
  );
  expect(offloader.getKeyPrefix()).toBe('langgraph-checkpoints/');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- config.test.ts offloader.test.ts`
Expected: FAIL — actual output still matches the old raw-join format.

- [ ] **Step 3: Implement the fix**

In `src/shared/codec/s3/config.ts`, replace `buildS3Key`:

```ts
/**
 * Build a fully-qualified S3 key: `${prefix}${parts, each base64url-encoded,
 * joined with '/'}.bin`. Encoding (not rejecting) is what makes two distinct
 * `parts` arrays never collide, since a namespace element or key is allowed
 * to contain '/' (only the DynamoDB '#' separator is forbidden at the
 * validation layer) and base64url's output alphabet never contains '/'.
 */
export function buildS3Key(prefix: string, parts: readonly string[]): string {
  const encoded = parts.map((part) => Buffer.from(part, 'utf8').toString('base64url'));
  return `${prefix}${encoded.join('/')}.bin`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- config.test.ts offloader.test.ts`
Expected: PASS

- [ ] **Step 5: Run the full test suite plus typecheck/lint/build to catch any other test asserting the old raw key format**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Expected: PASS. If any other test (e.g. an integration or conformance test) asserts a literal S3 key string, update it the same way — search first with a repo-wide grep for `.bin` in `test/` to find any other affected assertions before running.

- [ ] **Step 6: Commit** (only if the user has asked for commits during this plan's execution)

```bash
git add src/shared/codec/s3/config.ts test/unit/shared/codec/s3/config.test.ts test/unit/shared/codec/s3/offloader.test.ts
git commit -m "fix(s3): base64url-encode key parts to prevent S3 key collisions"
```

---

## Task 2: Fix `S3Offloader.getClient()` check-then-act race

**Severity:** Medium — resource leak (orphaned `S3Client` instances), reachable via the library's own primary checkpoint-read path (`assembleTuple`'s `Promise.all` over `readCheckpoint`/`readMetadata`/`fetchPendingWrites`, each independently calling `decodePayload` → `offloader.download()` → `getClient()` on a cold offloader).

**Confirmed bug:** `getClient()` (`src/shared/codec/s3/offloader.ts:32-40`) does `if (!this.client) { ...await...; this.client = ...; }` — two concurrent first-calls can both observe `!this.client` as true before either finishes awaiting, so both construct an `S3Client`, and the second assignment silently orphans the first (never `destroy()`'d).

**Mitigation:** cache the in-flight *promise*, not the resolved client (the standard "singleton promise" pattern for async lazy initialization), so concurrent callers await the same construction.

**Files:**
- Modify: `src/shared/codec/s3/offloader.ts`
- Test: `test/unit/shared/codec/s3/offloader.test.ts`

**Interfaces:**
- `S3Offloader.getClient()` stays `private`; its return type (`Promise<S3Client>`) and every public method's behavior are unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/shared/codec/s3/offloader.test.ts`:

```ts
it('createS3Client factory is invoked exactly once under concurrent first access', async () => {
  s3Mock.on(PutObjectCommand).resolves({});
  const createS3Client = jest.fn(() => new S3Client({ region: 'us-east-1' }));
  const offloader = new S3Offloader({ bucketName: 'b', createS3Client });
  await Promise.all([
    offloader.upload('a.bin', new Uint8Array([1])),
    offloader.upload('b.bin', new Uint8Array([1])),
  ]);
  expect(createS3Client).toHaveBeenCalledTimes(1);
});
```

The existing sequential-reuse test (`'reuses the single created client across calls'`) only proves sequential reuse, not concurrent-safety — this new test is the direct, sufficient proof of the fix.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- offloader.test.ts -t "concurrent first access"`
Expected: `createS3Client` here is synchronous, so this specific test may pass even on the buggy implementation (Node's event loop never yields between the check and the assignment on a fully synchronous path). Treat this step as a design confirmation rather than a strict red/green: read `getClient()` before and after the fix side-by-side to confirm the fix is correct. The real regression this guards against is on the *default* (no `createS3Client`) async path, via `createDefaultS3Client` — which isn't independently call-count-observable without changing the public surface, so the `createS3Client`-seam test above is the reliable, strict regression test to rely on.

- [ ] **Step 3: Implement the fix**

In `src/shared/codec/s3/offloader.ts`, replace the `client` field and `getClient` method:

```ts
export class S3Offloader {
  private clientPromise: Promise<S3Client> | undefined;
  private resolvedClient: S3Client | undefined;
  // ...unchanged fields...

  private getClient(): Promise<S3Client> {
    if (!this.clientPromise) {
      const cfg = this.config.clientConfig ?? {};
      this.clientPromise = this.config.createS3Client
        ? Promise.resolve(this.config.createS3Client(cfg))
        : createDefaultS3Client(cfg);
      this.clientPromise.then((client) => {
        this.resolvedClient = client;
      });
    }
    return this.clientPromise;
  }

  // ...

  /** Release the underlying S3 client, if one was created. */
  destroy(): void {
    this.resolvedClient?.destroy();
  }
}
```

Note: `getClient()` no longer needs `async`/`await` — it can return the cached promise directly (a synchronous function returning a `Promise<S3Client>` is a valid drop-in for every existing `await this.getClient()` call site). `destroy()` now destroys `resolvedClient` (only set once the promise actually settles) instead of `client`, avoiding both "destroy a not-yet-constructed client" and "destroy before an in-flight promise resolves, leaking that one" — this fixes a secondary latent issue in the original `destroy()` too (calling `destroy()` while construction is still in flight previously no-op'd silently, potentially leaking the client once it resolved after `destroy()` ran).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- offloader.test.ts`
Expected: PASS, including all pre-existing tests (`'reuses the single created client across calls'`, `'destroy releases the client without error even before first use'`, `'builds a default S3 client when no factory seam is given'`).

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/shared/codec/s3/offloader.ts test/unit/shared/codec/s3/offloader.test.ts
git commit -m "fix(s3): cache the in-flight client promise to close a construction race"
```

---

## Task 3: Fix `putWrites` idempotency (checkpoint contract violation)

**Severity:** Critical — corrupts resumed graph state on task re-execution.

**Confirmed bug:** `putWrites` (`src/checkpointer/actions/put-writes.ts:41-45`) writes every item via unconditional `BatchWriteItem` `PutRequest`. Verified against **three independent official reference implementations** (all re-fetched live from `langchain-ai/langgraph`/`langgraphjs` on GitHub, not from training-data memory):
- JS `MemorySaver.putWrites` (`node_modules/@langchain/langgraph-checkpoint/dist/memory.js:245`): `if (innerKey[1] >= 0 && outerWrites_ && innerKeyStr in outerWrites_) return;` — skips (first-write-wins) for non-negative index.
- Python Postgres saver (`libs/checkpoint-postgres/.../base.py`): `INSERT_CHECKPOINT_WRITES_SQL` uses `ON CONFLICT (thread_id, checkpoint_ns, checkpoint_id, task_id, idx) DO NOTHING` for regular writes; `UPSERT_CHECKPOINT_WRITES_SQL` (`DO UPDATE`) is used only when *every* write's channel is in `WRITES_IDX_MAP` (the special negative-index channels: error/interrupt/scheduled/resume).
- Python SQLite saver: `INSERT OR IGNORE` for regular writes, `INSERT OR REPLACE` only for all-special-channel batches.

**Concrete real-world trigger** (not hypothetical — confirmed via reading the installed `@langchain/langgraph@1.3.2` Pregel loop source and a live, currently-open upstream issue): task IDs are deterministic (`uuid5` of `(namespace, checkpoint, step, trigger)`). `PregelLoop.putWrites` fires `checkpointer.putWrites(...)` as a tracked-but-not-awaited background promise; `_flushPendingWrites` can re-send the same writes at loop exit. `langchain-ai/langgraph#8039` (open, reproducible) documents that under `durability="sync"`, `put()`/`put_writes()` race with no ordering guarantee — if a process dies mid-superstep, resume can re-execute a node and call `putWrites` again for the same `(taskId, index)`. If that node is non-deterministic (LLM call, timestamp), the second call's value differs from the first. Every reference saver preserves the original; this saver currently silently overwrites it.

Also confirmed: `item-writer.ts`'s `buildWriteItems` **already stamps `index` on every item** (`WRITES_IDX_MAP[channel] ?? positional`), so no new data needs to be threaded through — only `put-writes.ts` needs to change.

Also confirmed: this project's own `CHANGELOG.md` (pre-0.3.0) shows `put()` (checkpoint metadata) once used an `attribute_not_exists(...)` conditional guard, dropped in the 0.3.0 rewrite and never applied to `putWrites` at all — the right idiom was already known in this codebase, just not applied here.

**Chosen mitigation:** split the write path by `item.index`. Special items (`index < 0`) keep the current unconditional `batchWriteAll` — overwrite is *correct* there. Regular items (`index >= 0`) switch to individual conditional `PutCommand`s (`ConditionExpression: 'attribute_not_exists(PK)'`), run concurrently, each wrapped in `withDynamoDBRetry`. A `ConditionalCheckFailedException` on a regular item is caught and treated as an expected no-op (first write already won), with that item's S3 upload (if offloaded) cleaned up as an orphan. `TransactWriteItems` was considered and rejected for the regular-write path: it's all-or-nothing, so one re-executed item's condition failure would cancel the *entire* transaction including any genuinely-new items in the same call — the wrong semantics (every reference saver does per-row skip, not all-or-nothing rollback).

**Files:**
- Modify: `src/checkpointer/actions/put-writes.ts`
- Test: `test/unit/checkpointer/actions/put-writes.test.ts`
- Test: `test/conformance/checkpointer.conformance.test.ts` (add the idempotency case alongside the existing special-write-overwrite conformance test)

**Interfaces:**
- `putWrites(context, config, writes, taskId): Promise<void>` — signature unchanged.
- Consumes: `CheckpointWriteItem.index: number` (already produced by `buildWriteItems`, `src/checkpointer/internal/item-writer.ts:77`).

- [ ] **Step 1: Write the failing unit test**

Add to `test/unit/checkpointer/actions/put-writes.test.ts`:

```ts
import { PutCommand } from '@aws-sdk/lib-dynamodb';
// (BatchWriteCommand import already present)

it('is idempotent for a regular write: a second call with a different value is silently skipped', async () => {
  const { client, mock } = createStrictDocumentMock();
  mock.on(PutCommand).rejectsOnce(
    Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }),
  );
  await putWrites(
    context(client),
    { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
    [['ch', 'second']],
    'task-1',
  );
  // Should not throw — a ConditionalCheckFailedException on a regular write
  // means the first write already won, which is success, not failure.
  expect(mock.commandCalls(PutCommand)).toHaveLength(1);
});

it('uses unconditional BatchWriteItem for special (negative-index) writes only', async () => {
  const { client, mock } = createStrictDocumentMock();
  mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
  await putWrites(
    context(client),
    { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
    [['__error__', 'boom']],
    'task-1',
  );
  expect(mock.commandCalls(BatchWriteCommand)).toHaveLength(1);
  expect(mock.commandCalls(PutCommand)).toHaveLength(0);
});

it('uses conditional PutCommand for regular (non-negative-index) writes', async () => {
  const { client, mock } = createStrictDocumentMock();
  mock.on(PutCommand).resolves({});
  await putWrites(
    context(client),
    { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
    [['ch', 'a']],
    'task-1',
  );
  expect(mock.commandCalls(PutCommand)).toHaveLength(1);
  expect(mock.commandCalls(PutCommand)[0].args[0].input.ConditionExpression).toBe(
    'attribute_not_exists(PK)',
  );
});

it('cleans up the orphaned S3 upload when a regular write loses the idempotency race', async () => {
  const { client, mock } = createStrictDocumentMock();
  mock.on(PutCommand).rejects(
    Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }),
  );
  const offloader = {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[]) => parts.join('/'),
    upload: async (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
  const ctx = { ...context(client), offloader: offloader as never };
  await putWrites(
    ctx,
    { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
    [['ch', 'a']],
    'task-1',
  );
  expect(offloader.deleteBatch).toHaveBeenCalledWith(['t//c1/task-1/write-0']);
});
```

Update the existing `'batch-writes one item per write with the right keys'` test: both writes there use a plain channel `'ch'` (regular index), so under the fix they'll go through `PutCommand`, not `BatchWriteCommand`. Rewrite it to assert on `PutCommand` calls instead:

```ts
it('writes one conditional PutCommand per regular write with the right keys', async () => {
  const { client, mock } = createStrictDocumentMock();
  mock.on(PutCommand).resolves({});
  await putWrites(
    context(client),
    { configurable: { thread_id: 't', checkpoint_id: 'c1' } },
    [
      ['ch', 'a'],
      ['ch', 'b'],
    ],
    'task-3',
  );
  const calls = mock.commandCalls(PutCommand);
  expect(calls).toHaveLength(2);
  expect(calls[0].args[0].input.Item?.SK).toBe('WRITE##c1#task-3#0000000008');
  expect(calls[1].args[0].input.Item?.SK).toBe('WRITE##c1#task-3#0000000009');
});
```

Also update `'stamps a ttl attribute on each write item when ttl is configured'` and `'rethrows a write failure without cleanup when no offloader is configured'` to mock `PutCommand` instead of `BatchWriteCommand` (both use a plain `'ch'` channel, so both now go through the conditional-write path). `'is a no-op for an empty writes list'` and `'rejects a taskId containing the reserved separator'`/`'throws VALIDATION when checkpoint_id is missing'` are unaffected (they never reach the write dispatch).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- put-writes.test.ts`
Expected: FAIL — current implementation always uses `BatchWriteCommand`, never `PutCommand`.

- [ ] **Step 3: Implement the fix**

Replace `src/checkpointer/actions/put-writes.ts`:

```ts
import type { RunnableConfig } from '@langchain/core/runnables';
import type { PendingWrite } from '@langchain/langgraph-checkpoint';

import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import { ValidationError } from '../../shared/errors/errors';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { readConfigurable } from '../internal/configurable';
import { buildWriteItems } from '../internal/item-writer';
import type { CheckpointWriteItem } from '../types';
import type { CheckpointerContext } from '../internal/setup';
import { validateTaskId } from '../internal/validation';

function isConditionalCheckFailed(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

/**
 * Write special (negative-index) items unconditionally — overwrite is
 * correct for error/interrupt/scheduled/resume channels, matching every
 * reference checkpointer implementation.
 */
async function writeSpecialItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<void> {
  if (items.length === 0) return;
  await batchWriteAll(
    context.client,
    context.tableName,
    items.map((item) => ({ PutRequest: { Item: item } })),
  );
}

/**
 * Write regular (non-negative-index) items with a first-write-wins guard,
 * matching the LangGraph checkpoint contract: a task re-executed after a
 * partial prior commit must not clobber an already-recorded write.
 */
async function writeRegularItems(
  context: CheckpointerContext,
  items: CheckpointWriteItem[],
): Promise<{ orphaned: CheckpointWriteItem[] }> {
  const orphaned: CheckpointWriteItem[] = [];
  await Promise.all(
    items.map(async (item) => {
      try {
        await withDynamoDBRetry(() =>
          context.client.put({
            TableName: context.tableName,
            Item: item,
            ConditionExpression: 'attribute_not_exists(PK)',
          }),
        );
      } catch (error) {
        if (!isConditionalCheckFailed(error)) throw error;
        orphaned.push(item);
      }
    }),
  );
  return { orphaned };
}

/**
 * Persist a task's intermediate writes for a checkpoint as one item per write.
 * Requires `checkpoint_id` in the config — writes always attach to a checkpoint.
 * Regular writes are first-write-wins (idempotent under task re-execution,
 * matching the reference checkpointer contract); special negative-index
 * writes (error/interrupt/scheduled/resume) are always overwritten.
 */
export async function putWrites(
  context: CheckpointerContext,
  config: RunnableConfig,
  writes: PendingWrite[],
  taskId: string,
): Promise<void> {
  validateTaskId(taskId);
  const { threadId, checkpointNs, checkpointId } = readConfigurable(config);
  if (checkpointId === undefined) {
    throw new ValidationError('checkpoint_id is required to store writes', 'checkpoint_id');
  }
  if (writes.length === 0) return;
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const items = await buildWriteItems(
    context,
    threadId,
    checkpointNs,
    checkpointId,
    taskId,
    writes,
    ttlTimestamp,
  );
  const special = items.filter((item) => item.index < 0);
  const regular = items.filter((item) => item.index >= 0);
  try {
    const [, { orphaned }] = await Promise.all([
      writeSpecialItems(context, special),
      writeRegularItems(context, regular),
    ]);
    if (orphaned.length > 0 && context.offloader) {
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys(orphaned.map((item) => item.value)),
        'putWrites',
        context.logger,
      );
    }
  } catch (error) {
    if (context.offloader) {
      await cleanUpS3Orphans(
        context.offloader,
        collectS3Keys(items.map((item) => item.value)),
        'putWrites',
        context.logger,
      );
    }
    throw error;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- put-writes.test.ts`
Expected: PASS

- [ ] **Step 5: Add the conformance test**

In `test/conformance/checkpointer.conformance.test.ts`, alongside the existing `describe('DynamoDBSaver conformance: WRITES_IDX_MAP special-write contract', ...)`, add (`threadConfig(threadId, checkpointId?)`, `checkpoint(id)`, and `writesFor(threadId, checkpointId)` are the file's existing helpers — confirmed matching the signatures above exactly; this insertion needs no further adjustment):

```ts
it('is idempotent for a regular write when a task re-emits with a different value', async () => {
  const threadId = 'conf-idempotent';
  await saver.put(threadConfig(threadId), checkpoint('cp-1'), metadata, {});
  await saver.putWrites(threadConfig(threadId, 'cp-1'), [['channel-a', 'first']], 'task-1');
  await saver.putWrites(threadConfig(threadId, 'cp-1'), [['channel-a', 'second']], 'task-1');
  const writes = await writesFor(threadId, 'cp-1');
  expect(writes).toEqual([['channel-a', 'first']]);
  await saver.deleteThread(threadId);
});
```

- [ ] **Step 6: Run full validation including integration/conformance tests**

Run: `npm run typecheck && npm run lint && npm run build && npm test`
Then (requires Docker; ask the user before starting containers): `npm run test:integration:up && npm run test:conformance ; npm run test:integration:down`
Expected: all PASS

- [ ] **Step 7: Commit**

```bash
git add src/checkpointer/actions/put-writes.ts test/unit/checkpointer/actions/put-writes.test.ts test/conformance/checkpointer.conformance.test.ts
git commit -m "fix(checkpointer): make putWrites idempotent for regular writes, matching the reference checkpoint contract"
```

---

## Task 4: Fix `getMessages` breaking past the default pagination cap

**Severity:** High — breaks the hot-path read (every conversational turn) for any session over 10,000 messages.

**Confirmed bug:** `getMessages` (`src/history/actions/get-messages.ts:28-31`) calls `paginateQuery` with no `maxItems`/`maxIterations` override, so the default caps (`MAX_TOTAL_ITEMS_IN_MEMORY = 10000`, `MAX_LOOP_ITERATIONS = 1000`, `src/shared/constants.ts:8,11`) apply, throwing `ResultTruncatedError` once exceeded — unlike `deleteThread` (`src/checkpointer/actions/delete-thread.ts:68-69`), which explicitly overrides both to `Infinity` for exactly this kind of full-partition read.

**Confirmed this is the architecturally correct fix, not just a copy of `deleteThread`'s pattern:** re-verified against `node_modules/@langchain/core/dist/chat_history.d.ts` directly — `BaseChatMessageHistory`/`BaseListChatMessageHistory` both declare `abstract getMessages(): Promise<BaseMessage[]>` with **zero parameters, no cursor, no limit**. Also fetched the official `@langchain/community` reference `DynamoDBChatMessageHistory.getMessages()` implementation — it does a single unbounded read with no truncation logic at all. The LangChain ecosystem's contract is "return everything"; pagination/history-trimming is documented as an *application-layer* concern (`trimMessages`, summarization), never the storage backend's. So "read to completion, like `deleteThread`" is correct, not a compromise.

**Files:**
- Modify: `src/history/actions/get-messages.ts`
- Test: `test/unit/history/actions/get-messages.test.ts`

**Interfaces:** `getMessages(context, sessionId): Promise<BaseMessage[]>` — signature unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/history/actions/get-messages.test.ts`, reusing the file's existing `buildMessageItem`/`context` helpers and `mapChatMessagesToStoredMessages` import:

```ts
it('reads past the default in-memory item cap instead of throwing', async () => {
  const { client, mock } = createStrictDocumentMock();
  const [human] = mapChatMessagesToStoredMessages([new HumanMessage('hi')]);
  const pageSize = 2500;
  const pageCount = 5; // 12,500 items total, > the 10,000 default cap
  for (let i = 0; i < pageCount; i++) {
    const items = await Promise.all(
      Array.from({ length: pageSize }, (_, j) =>
        buildMessageItem(context(client), 's1', `01${i}${j}`, human),
      ),
    );
    mock.on(QueryCommand).resolvesOnce({
      Items: items,
      LastEvaluatedKey: i < pageCount - 1 ? { PK: 's1', SK: String(i) } : undefined,
    });
  }
  const result = await getMessages(context(client), 's1');
  expect(result).toHaveLength(pageSize * pageCount);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- get-messages.test.ts`
Expected: FAIL with `ResultTruncatedError`.

- [ ] **Step 3: Implement the fix**

In `src/history/actions/get-messages.ts`, change the `paginateQuery` call:

```ts
for await (const raw of paginateQuery({
  client: context.client,
  params: messageQuery(context.tableName, sessionId),
  maxItems: Number.POSITIVE_INFINITY,
  maxIterations: Number.POSITIVE_INFINITY,
})) {
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- get-messages.test.ts`
Expected: PASS

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/history/actions/get-messages.ts test/unit/history/actions/get-messages.test.ts
git commit -m "fix(history): read a session's full message history instead of capping at 10k items"
```

---

## Task 5: Fix `clearSession` — pagination cap AND missing incremental flush

**Severity:** High — two independent bugs; a session over 10,000 messages is permanently un-clearable, and any mid-listing failure (not just the cap) discards all progress.

**Confirmed bugs:** `clearSession` (`src/history/actions/clear.ts:16-37`) (1) has the same missing-override pagination cap as Task 4, and (2) accumulates the *entire* `deletes` array before the **first** `batchWriteAll` call — unlike `deleteThread`'s `DeleteBuffer`/`bufferItem`/`flushBuffer` pattern (`src/checkpointer/actions/delete-thread.ts:20-52`), which flushes every `BATCH_WRITE_MAX` (25) items *during* the loop. So even setting the cap aside, any failure partway through listing (retry exhaustion, abort) currently discards all progress, whereas the buffered pattern makes partial progress durable.

**Files:**
- Modify: `src/history/actions/clear.ts`
- Test: `test/unit/history/actions/clear.test.ts`

**Interfaces:** `clearSession(context, sessionId): Promise<void>` — signature unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/history/actions/clear.test.ts`, reusing the file's existing `inlineMessage`/`context` helpers:

```ts
it('flushes deletes incrementally rather than accumulating the whole session first', async () => {
  const { client, mock } = createStrictDocumentMock();
  const pageSize = 30; // > BATCH_WRITE_MAX (25), forcing at least 2 flushes
  mock.on(QueryCommand).resolvesOnce({
    Items: Array.from({ length: pageSize }, (_, i) => ({
      PK: 'sess-1',
      SK: `MSG#${i}`,
      message: inlineMessage,
    })),
  });
  mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
  await clearSession(context(client), 'sess-1');
  expect(mock.commandCalls(BatchWriteCommand).length).toBeGreaterThanOrEqual(2);
});

it('reads past the default in-memory item cap instead of throwing', async () => {
  const { client, mock } = createStrictDocumentMock();
  const pageSize = 2500;
  const pageCount = 5; // 12,500 items, > the 10,000 default cap
  for (let i = 0; i < pageCount; i++) {
    mock.on(QueryCommand).resolvesOnce({
      Items: Array.from({ length: pageSize }, (_, j) => ({
        PK: 'sess-1',
        SK: `MSG#${i}-${j}`,
        message: inlineMessage,
      })),
      LastEvaluatedKey: i < pageCount - 1 ? { PK: 'sess-1', SK: String(i) } : undefined,
    });
  }
  mock.on(BatchWriteCommand).resolves({ UnprocessedItems: {} });
  await clearSession(context(client), 'sess-1');
  expect(mock.commandCalls(BatchWriteCommand).length).toBeGreaterThan(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- clear.test.ts`
Expected: FAIL (single `BatchWriteCommand` call / `ResultTruncatedError`).

- [ ] **Step 3: Implement the fix** — mirror `deleteThread`'s buffer/flush structure directly in `clear.ts`

```ts
import type { PayloadDescriptor } from '../../shared/codec/codec';
import { collectS3Keys } from '../../shared/codec/descriptor-keys';
import { cleanUpS3Orphans } from '../../shared/codec/s3/orphans';
import { BATCH_WRITE_MAX } from '../../shared/constants';
import { batchWriteAll } from '../../shared/dynamodb/batch-write';
import { paginateQuery } from '../../shared/dynamodb/paginate';
import type { DeleteWriteRequest } from '../../shared/dynamodb/types';
import { sessionItemsQuery } from '../internal/query';
import type { HistoryContext } from '../internal/setup';
import type { ChatMessageItem } from '../types';

interface DeleteBuffer {
  keys: { PK: string; SK: string }[];
  descriptors: PayloadDescriptor[];
}

async function flushBuffer(context: HistoryContext, buffer: DeleteBuffer): Promise<void> {
  if (buffer.keys.length === 0) return;
  await batchWriteAll(
    context.client,
    context.tableName,
    buffer.keys.map((Key) => ({ DeleteRequest: { Key } })),
  );
  if (context.offloader) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys(buffer.descriptors),
      'history.clear',
      context.logger,
    );
  }
  buffer.keys = [];
  buffer.descriptors = [];
}

/**
 * Delete a whole session: every message item plus the metadata item, flushed
 * in bounded batches as they're listed, plus best-effort S3 cleanup. Streams
 * the partition with unbounded pagination so a session of any size is
 * deleted to completion with bounded memory — never silently truncated at
 * the in-memory page caps, and never discards already-flushed progress if a
 * later batch fails.
 */
export async function clearSession(context: HistoryContext, sessionId: string): Promise<void> {
  const buffer: DeleteBuffer = { keys: [], descriptors: [] };
  const pages = paginateQuery({
    client: context.client,
    params: sessionItemsQuery(context.tableName, sessionId),
    maxItems: Number.POSITIVE_INFINITY,
    maxIterations: Number.POSITIVE_INFINITY,
  });
  for await (const raw of pages) {
    const item = raw as ChatMessageItem;
    buffer.keys.push({ PK: item.PK, SK: item.SK });
    if (item.message) buffer.descriptors.push(item.message);
    if (buffer.keys.length >= BATCH_WRITE_MAX) await flushBuffer(context, buffer);
  }
  await flushBuffer(context, buffer);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- clear.test.ts`
Expected: PASS

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/history/actions/clear.ts test/unit/history/actions/clear.test.ts
git commit -m "fix(history): flush clearSession deletes incrementally and remove its pagination cap"
```

---

## Task 6: Fix vector-index `refIdentity` collision on the space separator

**Severity:** High — permanent, silent divergence between the vector backend and DynamoDB (the documented source of truth).

**Confirmed bug:** `refIdentity` (`src/store/internal/index-reconcile.ts:12,22-24`) joins with `REF_KEY_SEPARATOR = ' '` (a literal space), which `validateNamespace`/`validateKey` never reject (only `#` is forbidden). `namespace=['a','b'],key='c'` and `namespace=['a b'],key='c']` both produce `"a b c"` — confirmed these are genuinely two different, independently-writable DynamoDB items (different `partitionKey`/`sortKey`, which correctly use `'#'`, the one separator actually validated-absent). If one is live and the other's backend vector is stale, `selectOrphans` falsely treats the stale one as live and `pruneOrphans` never deletes it.

**Confirmed zero backward-compatibility risk:** `refIdentity`'s output is a purely ephemeral, in-process `Set` key recomputed fresh on every `reconcileVectorIndex` call — never persisted to DynamoDB, never passed to any `VectorBackend` method (all of which take structured `namespace: string[]`/`key: string`). This is a pure internal refactor.

**Files:**
- Modify: `src/store/internal/index-reconcile.ts`
- Test: `test/unit/store/internal/index-reconcile.test.ts`

**Interfaces:** `refIdentity` stays module-private; `selectOrphans`/`pruneOrphans`/`collectReconcileTargets`/`pushEmbeddings` signatures unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/store/internal/index-reconcile.test.ts`, in the `selectOrphans` describe block:

```ts
it('does not collide a multi-element namespace with a single element containing the separator', () => {
  const live = [{ namespace: ['a', 'b'], key: 'c', embedding: [1] }];
  const backendRefs = [{ namespace: ['a b'], key: 'c' }];
  expect(selectOrphans(backendRefs, live)).toEqual([{ namespace: ['a b'], key: 'c' }]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- index-reconcile.test.ts`
Expected: FAIL — `selectOrphans` returns `[]` (the space-separated collision hides the orphan).

- [ ] **Step 3: Implement the fix**

In `src/store/internal/index-reconcile.ts`, remove `REF_KEY_SEPARATOR` and replace `refIdentity`:

```ts
/** Stable, collision-free identity for a (namespace, key) pair. */
function refIdentity(namespace: string[], key: string): string {
  return JSON.stringify([...namespace, key]);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- index-reconcile.test.ts`
Expected: PASS, including all pre-existing tests.

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/store/internal/index-reconcile.ts test/unit/store/internal/index-reconcile.test.ts
git commit -m "fix(store): make vector-reconcile identity collision-free via JSON encoding"
```

---

## Task 7: Fix empty filter object `{}` vacuously matching every item

**Severity:** Medium-high — public-API search-result over-exposure.

**Confirmed bug:** `isOperatorObject` (`src/store/internal/filter.ts:18-25`) treats `{}` as a valid zero-operator "operator object" (`Object.keys({}).every(...)` is vacuously `true`), and `matchesCondition`'s `Object.entries({}).every(...)` is then also vacuously `true` — so `store.search(prefix, { filter: { role: {} } })` matches every item regardless of whether `role` exists. This is distinct from (and doesn't affect) the existing, correct `matchesStoreFilter(value, {})` behavior (a *top-level* empty filter legitimately means "match everything") — the bug is specifically a *nested* empty condition on one field.

**Files:**
- Modify: `src/store/internal/filter.ts`
- Test: `test/unit/store/internal/filter.test.ts`

**Interfaces:** `matchesStoreFilter`/`isOperatorObject`/`matchesCondition` signatures unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/store/internal/filter.test.ts`:

```ts
it('does not vacuously match every item when a field condition is an empty operator object', () => {
  const value = { status: 'active' };
  expect(matchesStoreFilter(value, { role: {} })).toBe(false);
  expect(matchesStoreFilter({ role: 'admin' }, { role: {} })).toBe(false);
  // A structurally-equal empty object as the field's actual value still
  // exact-matches, since {} then falls through to the plain-value branch:
  expect(matchesStoreFilter({ role: {} }, { role: {} })).toBe(true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- filter.test.ts`
Expected: FAIL — `matchesStoreFilter(value, { role: {} })` currently returns `true`.

- [ ] **Step 3: Implement the fix**

In `src/store/internal/filter.ts`, change `isOperatorObject`:

```ts
function isOperatorObject(condition: JsonValue): condition is { [key: string]: JsonValue } {
  return (
    typeof condition === 'object' &&
    condition !== null &&
    !Array.isArray(condition) &&
    Object.keys(condition).length > 0 &&
    Object.keys(condition).every((key) => key.startsWith('$'))
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- filter.test.ts`
Expected: PASS, including `'matches the empty filter'` (unaffected — that test passes `{}` as the *whole filter*, not as a field condition, so `Object.entries({}).every(...)` at the `matchesStoreFilter` level is untouched by this change).

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/store/internal/filter.ts test/unit/store/internal/filter.test.ts
git commit -m "fix(store): stop an empty per-field filter condition from vacuously matching every item"
```

---

## Task 8: Fix S3 orphan leak on `store.put(ns, key, null)` (delete)

**Severity:** Medium-high — unbounded S3 storage cost growth.

**Confirmed bug:** `deleteStoreItem` (`src/store/actions/put.ts:35-47`) never reads the existing item before deleting it, so an offloaded value's S3 object is never cleaned up — unlike `deleteThread`/`clearSession`, which both collect descriptors before deleting. `persistRecord` in the same file already proves the codebase knows how to extract the key from a `PayloadDescriptor` (its own failure-path cleanup does exactly this), it's just never applied to the delete path.

**Files:**
- Modify: `src/store/actions/put.ts`
- Test: `test/unit/store/actions/put.test.ts`

**Interfaces:** `putItem(context, op): Promise<void>` — signature unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/store/actions/put.test.ts`, reusing the file's existing `context`/`op` helpers (`op({ value: null })` is already the exact shape the pre-existing `'deletes when value is null'` test uses — that existing test configures no offloader, so it's unaffected by this change and needs no edit):

```ts
it('cleans up the offloaded S3 object when a large value is deleted', async () => {
  const { client, mock } = createStrictDocumentMock();
  mock.on(GetCommand).resolves({
    Item: { value: { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'users/u1/profile.bin' } },
  });
  mock.on(DeleteCommand).resolves({});
  const offloader = {
    shouldOffload: () => true,
    buildKey: (parts) => parts.join('/'),
    upload: async (key) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
  };
  await putItem(context(client, { offloader: offloader as never }), op({ value: null }));
  expect(offloader.deleteBatch).toHaveBeenCalledWith(['users/u1/profile.bin']);
});

it('does not attempt S3 cleanup on delete when no offloader is configured', async () => {
  const { client, mock } = createStrictDocumentMock();
  mock.on(DeleteCommand).resolves({});
  await putItem(context(client), op({ value: null }));
  expect(mock.commandCalls(GetCommand)).toHaveLength(0);
});
```

Add `import { PayloadLocation } from '../../../../src/shared/codec/codec';` to the test file's imports (matching how `clear.test.ts` and `append-saga.test.ts` already import it).

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- put.test.ts`
Expected: FAIL — `deleteBatch` never called.

- [ ] **Step 3: Implement the fix**

In `src/store/actions/put.ts`, add a targeted read before delete:

```ts
async function readValueDescriptor(
  context: StoreContext,
  pk: string,
  sk: string,
): Promise<PayloadDescriptor | undefined> {
  const existing = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: pk, SK: sk },
      ConsistentRead: true,
      ProjectionExpression: '#v',
      ExpressionAttributeNames: { '#v': 'value' },
    }),
  );
  return existing.Item?.value as PayloadDescriptor | undefined;
}

/** Delete the item and, when a vector backend is configured, drop its vector. */
async function deleteStoreItem(
  context: StoreContext,
  op: PutOperation,
  pk: string,
  sk: string,
): Promise<void> {
  const descriptor = context.offloader ? await readValueDescriptor(context, pk, sk) : undefined;
  await withDynamoDBRetry(() =>
    context.client.delete({ TableName: context.tableName, Key: { PK: pk, SK: sk } }),
  );
  if (context.offloader) {
    await cleanUpS3Orphans(
      context.offloader,
      collectS3Keys(descriptor ? [descriptor] : []),
      'store.delete',
      context.logger,
    );
  }
  if (context.vectorBackend) {
    await syncVectorIndex(context.vectorBackend, op.namespace, op.key, undefined, context.logger);
  }
}
```

Add `collectS3Keys` and `cleanUpS3Orphans` imports (mirroring `persistRecord`'s existing imports in the same file).

**Design note (no code change needed, documented for the reviewer):** this read-then-delete has an inherent TOCTOU race (the item could be updated between the read and the delete). Deliberately **not** made conditional on a version check — every other best-effort cleanup path in this codebase (`cleanUpS3Orphans`, vector-backend sync, `persistRecord`'s own failure cleanup) uses the same best-effort, logged-not-fatal model, and the S3 lifecycle rule (Task 9) is the documented backstop for exactly this class of missed cleanup. Adding optimistic concurrency control here would be inconsistent with the rest of the codebase for a rare race whose worst case is already tolerated elsewhere.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- put.test.ts`
Expected: PASS

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/store/actions/put.ts test/unit/store/actions/put.test.ts
git commit -m "fix(store): clean up the offloaded S3 object when a store item is deleted"
```

---

## Task 9: Make S3 lifecycle-rule provisioning an explicit opt-in, and correct the README

**Severity:** Medium-high — documented feature never executes; unbounded S3 storage growth for TTL users who trust the docs.

**Confirmed bug:** `ensureLifecycleRule` (`src/shared/codec/s3/offloader.ts:80-82`, delegating to `src/shared/codec/s3/lifecycle.ts:28`) has no caller anywhere in `src/` outside its own definition and tests. `README.md:202` states TTL + S3 together "best-effort installs a matching S3 lifecycle expiration rule" — this never happens. Confirmed via `git log` this was **never wired**, not a later regression (`cfe5903` added the function + its own tests only, never touched any `setup.ts`).

**Chosen mitigation (re-verified, not the "just wire it in" default):** researched `PutBucketLifecycleConfiguration`'s AWS permissions model and concurrency behavior. It requires a distinct, bucket-level administrative IAM permission (`s3:PutLifecycleConfiguration`) beyond the object-level CRUD permissions (`GetObject`/`PutObject`/`DeleteObject`) the rest of the offloader needs, and is known to throw `OperationAborted` under concurrent `Get`+`Put` races on the same bucket (confirmed via a GitHub issue on this exact API). Auto-firing this on every adapter construction would (a) require an IAM grant many least-privilege deployments won't have, and (b) risk that race under `DynamoDBFactory.createAll` (three adapters constructed together) or concurrent Lambda cold starts. **Ship it as an explicit opt-in method instead**, and fix the README to describe it accurately.

**Files:**
- Modify: `src/store/store.ts`, `src/checkpointer/saver.ts`, `src/history/chat-message-history.ts` (add one method each, following the exact shape of each class's existing `destroy()`/`reconcileVectorIndex()` delegation methods)
- Modify: `README.md` (correct line 202)
- Test: `test/unit/store/store.test.ts`, `test/unit/checkpointer/saver.test.ts`, `test/unit/history/chat-message-history.test.ts`

**Interfaces:**
- New public method on each adapter class: `ensureS3LifecycleRule(): Promise<void>` — no-ops (resolves immediately) when either `s3` or `ttl` wasn't configured.
- Consumes: `context.offloader?: S3Offloader`, `context.ttl?: TtlOption`, and `resolveTtlDaysCeil` (new, added to `src/shared/validation/ttl.ts`).

- [ ] **Step 1: Write the failing test** (shown for `DynamoDBStore`; mirror for `DynamoDBSaver`/`DynamoDBChatMessageHistory`)

Confirmed `test/unit/store/store.test.ts`'s existing convention: `DynamoDBStoreOptions` accepts an already-constructed `client` directly (from `createStrictDocumentMock()`), so tests inject a document-client mock rather than standing up a real `DynamoDBClient` — no `clientConfig` needed. For S3, reuse the `createS3Client` injection seam plus `GetBucketLifecycleConfigurationCommand`/`PutBucketLifecycleConfigurationCommand` mocks, matching `offloader.test.ts`'s own `ensureLifecycleRule` test exactly:

```ts
import { GetBucketLifecycleConfigurationCommand, PutBucketLifecycleConfigurationCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
// (add alongside this file's existing createStrictDocumentMock import)

const s3Mock = mockClient(S3Client);
afterEach(() => s3Mock.reset());

it('ensureS3LifecycleRule provisions the rule when both s3 and ttl are configured', async () => {
  const { client } = createStrictDocumentMock();
  s3Mock.on(GetBucketLifecycleConfigurationCommand).resolves({ Rules: [] });
  s3Mock.on(PutBucketLifecycleConfigurationCommand).resolves({});
  const store = new DynamoDBStore({
    tableName: 'store',
    client,
    s3: { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) },
    ttl: { days: 30 },
  });
  await store.ensureS3LifecycleRule();
  expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(1);
});

it('ensureS3LifecycleRule no-ops when ttl is not configured', async () => {
  const { client } = createStrictDocumentMock();
  const store = new DynamoDBStore({
    tableName: 'store',
    client,
    s3: { bucketName: 'b', createS3Client: () => new S3Client({ region: 'us-east-1' }) },
  });
  await expect(store.ensureS3LifecycleRule()).resolves.toBeUndefined();
  expect(s3Mock.commandCalls(PutBucketLifecycleConfigurationCommand)).toHaveLength(0);
});

it('ensureS3LifecycleRule no-ops when s3 is not configured', async () => {
  const { client } = createStrictDocumentMock();
  const store = new DynamoDBStore({ tableName: 'store', client, ttl: { days: 30 } });
  await expect(store.ensureS3LifecycleRule()).resolves.toBeUndefined();
});
```

Mirror all three tests for `DynamoDBSaver` (`test/unit/checkpointer/saver.test.ts`, constructor takes the same `{ tableName, client, s3, ttl }` shape per `DynamoDBSaverOptions`) and `DynamoDBChatMessageHistory` (`test/unit/history/chat-message-history.test.ts`, same shape per `DynamoDBChatMessageHistoryOptions`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- store.test.ts saver.test.ts chat-message-history.test.ts`
Expected: FAIL — method doesn't exist yet.

- [ ] **Step 3: Implement the fix**

In `src/shared/validation/ttl.ts`, add a small day-rounding helper next to `resolveTtlSeconds`:

```ts
/** Resolve a {@link TtlOption} to whole days, rounded up so the S3 lifecycle
 * expiration never fires before DynamoDB's own TTL sweep (which can lag up
 * to ~48h past the TTL timestamp) — expiring the S3 object first would leave
 * a live DynamoDB item pointing at a deleted payload. */
export function resolveTtlDaysCeil(ttl: TtlOption): number {
  return Math.ceil(resolveTtlSeconds(ttl) / SECONDS_PER_DAY);
}
```

The doc comment goes verbatim on all three classes' method (same wording each time, since the concern is identical). In `src/store/store.ts`, add the import and method:

```ts
import { resolveTtlDaysCeil } from '../shared/validation/ttl';

// inside class DynamoDBStore, alongside destroy():
/**
 * Best-effort provision an S3 lifecycle expiration rule matching the
 * configured TTL, so offloaded objects don't outlive their DynamoDB item
 * forever. No-ops when S3 offload or TTL isn't configured. Requires the
 * `s3:GetLifecycleConfiguration`/`s3:PutLifecycleConfiguration` bucket-level
 * permissions (broader than the object-level CRUD the rest of S3 offload
 * needs) — call this once during deployment/provisioning, not per-request.
 */
async ensureS3LifecycleRule(): Promise<void> {
  if (!this.context.offloader || !this.context.ttl) return;
  await this.context.offloader.ensureLifecycleRule(resolveTtlDaysCeil(this.context.ttl));
}
```

In `src/checkpointer/saver.ts`, add the same import and, alongside `destroy()`:

```ts
async ensureS3LifecycleRule(): Promise<void> {
  if (!this.context.offloader || !this.context.ttl) return;
  await this.context.offloader.ensureLifecycleRule(resolveTtlDaysCeil(this.context.ttl));
}
```

In `src/history/chat-message-history.ts`, add the same import and, alongside `destroy()`:

```ts
async ensureS3LifecycleRule(): Promise<void> {
  if (!this.context.offloader || !this.context.ttl) return;
  await this.context.offloader.ensureLifecycleRule(resolveTtlDaysCeil(this.context.ttl));
}
```

All three `context` types (`StoreContext`, `CheckpointerContext`, `HistoryContext`) need to actually carry an optional `ttl?: TtlOption` field for this to type-check — confirmed `context.ttl` is already referenced elsewhere in each domain (e.g. `src/store/actions/put.ts:98` reads `context.ttl`, `src/checkpointer/actions/put-writes.ts:30` reads `context.ttl`), so the field already exists on all three context types; no type changes needed beyond the new method itself.

In `README.md`, replace line 202's claim:

```diff
-**S3 offloading** — set `s3: { bucketName }`. Any serialized payload at or above `thresholdBytes` (default 350 KB) is written to S3, with only a reference stored in DynamoDB; reads rehydrate transparently. Requires the optional `@aws-sdk/client-s3` peer. When a `ttl` is also configured the library best-effort installs a matching S3 lifecycle expiration rule (logged, never fatal). Deleting a checkpoint thread / chat session also best-effort deletes its offloaded objects.
+**S3 offloading** — set `s3: { bucketName }`. Any serialized payload at or above `thresholdBytes` (default 350 KB) is written to S3, with only a reference stored in DynamoDB; reads rehydrate transparently. Requires the optional `@aws-sdk/client-s3` peer. Deleting a checkpoint thread / chat session also best-effort deletes its offloaded objects. When a `ttl` is also configured, call `ensureS3LifecycleRule()` once (e.g. during deployment) to best-effort install a matching S3 lifecycle expiration rule (logged, never fatal) — this is opt-in rather than automatic, since it requires the broader `s3:PutLifecycleConfiguration` bucket-level permission and is not safe to fire on every adapter construction.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- store.test.ts saver.test.ts chat-message-history.test.ts`

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/store/store.ts src/checkpointer/saver.ts src/history/chat-message-history.ts src/shared/validation/ttl.ts README.md test/unit/store/store.test.ts test/unit/checkpointer/saver.test.ts test/unit/history/chat-message-history.test.ts
git commit -m "fix(s3): expose S3 lifecycle-rule provisioning as an explicit opt-in and correct the README"
```

---

## Task 10: Fix append-saga compensation ordering (S3-before-DynamoDB race)

**Severity:** Medium — narrow race window causing a spurious read error, not silent corruption.

**Confirmed bug:** `compensate` (`src/history/internal/append-saga.ts:79-103`) calls `cleanBatchS3` (deletes S3 objects for the **whole** `chunks` array, including already-committed ones) at line 92, *before* `rollbackCommitted` deletes the corresponding DynamoDB rows at line 94. `getMessages` has no fallback for a missing S3 object (any error is rewrapped as `S3_OFFLOAD_FAILED` and rethrown) — a concurrent read racing inside that window sees a live DynamoDB row pointing at an already-deleted S3 key and throws. Confirmed against Microsoft's Compensating Transaction pattern docs: "if one data store is more sensitive to inconsistencies than another, undo changes to that store first... design the workflow so irreversible steps occur only after all critical validations succeed" — directly supports deleting DynamoDB (the store readers actually query) before S3 (only ever reached through a live row).

**Critically, a naive line-swap is NOT sufficient** (re-verification caught this): `rollbackCommitted` has zero S3 logic. If `cleanBatchS3` is moved to run unconditionally *after* the `try/catch` around `rollbackCommitted`, a rollback failure leaves committed DynamoDB rows possibly still present while their S3 objects get deleted anyway — turning today's *transient* race into a **permanent** dangling reference. If instead `cleanBatchS3` is moved inside the `try` (success-only), the never-committed suffix (the failed chunk + any never-attempted chunks) never gets cleaned at all on the rollback-failure path — a new S3 leak.

**Chosen mitigation:** exploit the invariant that `committed` is always a strict prefix of `chunks` (the `for...of` loop in `appendChunks` processes chunks strictly in order; `compensate` always throws on the first failure). Split cleanup by commit status: the uncommitted suffix (`chunks.slice(committed.length)`) is safe to clean immediately (no DynamoDB row ever referenced those objects); the committed prefix (`chunks.slice(0, committed.length)`) is only safe to clean *after* `rollbackCommitted` succeeds — never on its failure path, since those rows might still exist.

**Files:**
- Modify: `src/history/internal/append-saga.ts`
- Test: `test/unit/history/internal/append-saga.test.ts`

**Interfaces:** `appendChunks`/`compensate` signatures unchanged; `CommittedChunk`, `rollbackCommitted`, `revertSessionCount` unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/history/internal/append-saga.test.ts`, reusing the file's existing `s3Item`/`context` helpers. Chunk 0 (`s3Item('MSG#1', 'k1')`) commits (`TransactWriteCommand` resolves once); chunk 1 (`s3Item('MSG#2', 'k2')`) fails (`TransactWriteCommand` rejects) — same fixture shape as the existing `'rolls back committed chunks...'` test, but with `s3Item` in both chunks (that existing test uses `inlineItem`, which has no S3 key to track):

```ts
it('deletes the committed chunk DynamoDB row before its S3 object during compensation', async () => {
  const order: string[] = [];
  const { client, mock } = createStrictDocumentMock();
  mock
    .on(TransactWriteCommand)
    .resolvesOnce({})
    .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
  mock.on(BatchWriteCommand).callsFake(() => {
    order.push('ddb-delete');
    return Promise.resolve({ UnprocessedItems: {} });
  });
  mock.on(UpdateCommand).resolves({});
  const offloader = {
    deleteBatch: jest.fn(async (keys: string[]) => {
      if (keys.includes('k1')) order.push('s3-delete-k1');
      return [];
    }),
  };
  await expect(
    appendChunks(
      context(client, offloader),
      's1',
      [[s3Item('MSG#1', 'k1')], [s3Item('MSG#2', 'k2')]],
      { now: 'u' },
    ),
  ).rejects.toThrow('boom');
  expect(order).toEqual(['ddb-delete', 's3-delete-k1']);
});

it('does not delete a committed chunk S3 object when rollback itself fails', async () => {
  const { client, mock } = createStrictDocumentMock();
  mock
    .on(TransactWriteCommand)
    .resolvesOnce({})
    .rejects(Object.assign(new Error('boom'), { name: 'ValidationException' }));
  mock
    .on(BatchWriteCommand)
    .rejects(Object.assign(new Error('rollback-down'), { name: 'ValidationException' }));
  const offloader = { deleteBatch: jest.fn().mockResolvedValue([]) };
  await expect(
    appendChunks(
      context(client, offloader),
      's1',
      [[s3Item('MSG#1', 'k1')], [s3Item('MSG#2', 'k2')]],
      { now: 'u' },
    ),
  ).rejects.toMatchObject({ name: 'CompensationFailedError' });
  // The committed chunk's key (k1) must NOT be among the cleaned keys, since
  // its DynamoDB row's fate is unknown after a failed rollback. Only the
  // never-committed chunk's key (k2) is safe to have cleaned.
  expect(offloader.deleteBatch).not.toHaveBeenCalledWith(expect.arrayContaining(['k1']));
});
```

Under the *current* (buggy) implementation, the first test's `order` would be `['s3-delete-k1', 'ddb-delete']` (fails the assertion) and the second test's `deleteBatch` *would* be called with `['k1', 'k2']` together (fails the `not.toHaveBeenCalledWith` assertion) — both tests are genuine regression proofs, not tautologies.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- append-saga.test.ts`
Expected: FAIL as described above.

- [ ] **Step 3: Implement the fix**

In `src/history/internal/append-saga.ts`, replace `compensate`:

```ts
async function compensate(
  context: HistoryContext,
  sessionId: string,
  chunks: ChatMessageItem[][],
  committed: CommittedChunk[],
  trigger: Error,
): Promise<never> {
  if (committed.length > 0) {
    context.logger.warn('history.addMessages compensating committed chunks after a chunk failed', {
      sessionId,
      committedChunks: committed.length,
    });
  }
  // The failed chunk + any never-attempted chunks never had a DynamoDB row,
  // so no reader can ever reach them via a live item — safe to clean now.
  await cleanBatchS3(context, chunks.slice(committed.length));
  try {
    await rollbackCommitted(context, sessionId, committed);
  } catch (rollbackError) {
    context.logger.error('history.addMessages rollback failed; messageCount may have drifted', {
      sessionId,
      committedChunks: committed.length,
    });
    // Do NOT clean the committed chunks' S3 objects here: rollback may have
    // partially or fully failed, so their DynamoDB rows might still exist
    // and reference these objects. Leaving both intact keeps any surviving
    // row valid; CompensationFailedError signals the drift for manual repair.
    throw new CompensationFailedError(trigger, toError(rollbackError as Error));
  }
  // Only now that the committed chunks' DynamoDB rows are confirmed deleted
  // is it safe to delete their S3 objects — this closes the window where a
  // concurrent reader could see a live row pointing at a deleted object.
  await cleanBatchS3(context, chunks.slice(0, committed.length));
  throw trigger;
}
```

No changes needed to `CommittedChunk`, `rollbackCommitted`, `revertSessionCount`, or `cleanBatchS3` itself — only `compensate`'s call sites and slicing.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- append-saga.test.ts`
Expected: PASS, including all pre-existing tests (the existing "compensates committed chunks" test should still pass since total cleanup behavior on the happy-rollback path is unchanged, just reordered/split).

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/history/internal/append-saga.ts test/unit/history/internal/append-saga.test.ts
git commit -m "fix(history): delete committed rows before their S3 objects during append compensation"
```

---

## Task 11: Fix redaction `WeakSet` false-flagging DAG-shared objects as circular

**Severity:** Medium — logging correctness; legitimate diagnostic content silently replaced with a misleading marker.

**Confirmed bug:** `redactSecrets`/`walk` (`src/shared/logging/redaction.ts:37-55`) adds an object to `seen` on entry (line 45) and never removes it — a shared (non-cyclic) object reached via two different keys is misdiagnosed as circular on its second occurrence. Also breaks the documented Error passthrough: a repeated reference to the same `Error` gets `[Circular]` on its second occurrence instead of the actual object.

**Files:**
- Modify: `src/shared/logging/redaction.ts`
- Test: `test/unit/shared/logging/redaction.test.ts`

**Interfaces:** `redactSecrets`/`redactLogger` signatures unchanged.

- [ ] **Step 1: Write the failing tests**

Add to `test/unit/shared/logging/redaction.test.ts`:

```ts
it('does not flag a DAG-shared (non-cyclic) object as circular', () => {
  const shared = { note: 'hello' };
  const result = redactSecrets({ a: shared, b: shared });
  expect(result).toEqual({ a: { note: 'hello' }, b: { note: 'hello' } });
});

it('passes through a repeated (non-cyclic) Error reference at both occurrences', () => {
  const err = new Error('boom');
  const result = redactSecrets({ a: err, b: err }) as { a: unknown; b: unknown };
  expect(result.a).toBe(err);
  expect(result.b).toBe(err);
});
```

The existing `'does not mutate the input and breaks cycles'` test already covers the true-self-reference case — no new test needed for that; the two new tests above are the only additions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- redaction.test.ts`
Expected: FAIL — the DAG and repeated-Error tests currently return `'[Circular]'` for the second occurrence.

- [ ] **Step 3: Implement the fix**

In `src/shared/logging/redaction.ts`, track the active recursion path (pop on return) instead of a permanently-growing seen set:

```ts
export function redactSecrets(
  value: Redactable,
  patterns: readonly string[] = DEFAULT_SECRET_KEY_PATTERNS,
): Redactable {
  const seen = new WeakSet<object>();
  const walk = (current: Redactable): Redactable => {
    if (current === null || typeof current !== 'object') return current;
    if (seen.has(current)) return '[Circular]';
    seen.add(current);
    try {
      if (Array.isArray(current)) return current.map(walk);
      if (isErrorShaped(current)) return current;
      const out: { [key: string]: Redactable } = {};
      for (const [key, val] of Object.entries(current)) {
        out[key] = isSecretKey(key, patterns) ? REDACTED : walk(val);
      }
      return out;
    } finally {
      seen.delete(current);
    }
  };
  return walk(value);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- redaction.test.ts`
Expected: PASS

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/shared/logging/redaction.ts test/unit/shared/logging/redaction.test.ts
git commit -m "fix(logging): stop redactSecrets from false-flagging DAG-shared objects as circular"
```

---

## Task 12: Fix `searchViaBackend` missing namespace-prefix check

**Severity:** Medium — defense-in-depth gap for a publicly-pluggable interface.

**Confirmed bug:** `searchViaBackend` (`src/store/actions/search.ts:53-68`) calls `backend.query(...)` then fetches each match with no `namespaceMatchesPrefix` check, unlike `collectCandidates` (the native path), which explicitly guards at line 45. `VectorBackend` is confirmed publicly exported from `src/index.ts`.

**Files:**
- Modify: `src/store/actions/search.ts`
- Test: `test/unit/store/actions/search.test.ts`

**Interfaces:** `searchViaBackend`/`searchItems` signatures unchanged.

- [ ] **Step 1: Write the failing test**

Add to `test/unit/store/actions/search.test.ts`, reusing the file's existing `buildStoreItem`/`context` helpers (mirroring the existing `'delegates ranking to a vector backend and hydrates the matches'` test's exact setup shape):

```ts
it('skips a vector backend match outside the requested namespace prefix', async () => {
  const { client, mock } = createStrictDocumentMock();
  const embeddings = { embedQuery: jest.fn().mockResolvedValue([0, 1]) };
  const recA = await buildStoreItem(
    context(client),
    ['users', 'u1'],
    'a',
    { score: 1 },
    { createdAt: 'c', updatedAt: 'u' },
  );
  mock.on(GetCommand).resolves({ Item: recA });
  const vectorBackend = {
    upsert: jest.fn(),
    delete: jest.fn(),
    query: jest.fn().mockResolvedValue([
      { namespace: ['users', 'u1'], key: 'a', score: 0.9 },
      { namespace: ['other'], key: 'b', score: 0.8 },
    ]),
  };
  const ctx = context(client, {
    index: { dims: 2, embeddings: embeddings as never },
    vectorBackend: vectorBackend as never,
  });
  const items = await searchItems(ctx, { namespacePrefix: ['users'], query: 'q' });
  expect(items.map((i) => i.key)).toEqual(['a']);
  // getItem must only be called for the in-prefix match, not the skipped one.
  expect(mock.commandCalls(GetCommand)).toHaveLength(1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- search.test.ts`
Expected: FAIL — both matches currently returned.

- [ ] **Step 3: Implement the fix**

In `src/store/actions/search.ts`, add the guard to `searchViaBackend`:

```ts
async function searchViaBackend(
  context: StoreContext,
  backend: VectorBackend,
  index: IndexConfig,
  op: SearchOperation,
  topK: number,
): Promise<SearchItem[]> {
  const queryVector = await index.embeddings.embedQuery(op.query as string);
  const matches = await backend.query(op.namespacePrefix, queryVector, topK);
  const results: SearchItem[] = [];
  for (const match of matches) {
    if (!namespaceMatchesPrefix(match.namespace, op.namespacePrefix)) continue;
    const item = await getItem(context, match.namespace, match.key);
    if (item && passesFilter(item, op)) results.push({ ...item, score: match.score });
  }
  return results;
}
```

(`namespaceMatchesPrefix` is already imported in this file for `collectCandidates`.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- search.test.ts`
Expected: PASS

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/store/actions/search.ts test/unit/store/actions/search.test.ts
git commit -m "fix(store): guard searchViaBackend against out-of-prefix matches from a pluggable backend"
```

---

## Task 13: Fix `DynamoDBFactory.createAll` silently discarding per-adapter client config

**Severity:** Medium — compile-time footgun; silent misconfiguration.

**Confirmed bug:** `CreateAllOptions` (`src/factory/factory.ts:20-24`) only omits `'client'` from each adapter's options type, not `'clientConfig'`/`'createClient'`, so TypeScript accepts per-adapter client settings that `createAll()` then silently discards (it always spreads the one shared `client` last).

**Files:**
- Modify: `src/factory/factory.ts`
- Test: `test/types/public-api.test.ts` (type-level — primary regression guard)

**Interfaces:** `CreateAllOptions.saver`/`.store`/`.history` types narrow (compile-time only); `createAll` runtime behavior unchanged.

- [ ] **Step 1: Write the failing type-level test**

`CreateAllOptions` is already exported from the public entry point (`src/index.ts:11`), matching this file's existing convention of importing every type under test from `'../../src/index'` rather than internal module paths. Add to `test/types/public-api.test.ts`:

```ts
import type { CreateAllOptions } from '../../src/index';

// add alongside the existing `describe('public API types', ...)` tests:
it('CreateAllOptions.saver excludes clientConfig/createClient, not just client', () => {
  expectTypeOf<CreateAllOptions['saver']>().not.toHaveProperty('clientConfig');
  expectTypeOf<CreateAllOptions['saver']>().not.toHaveProperty('createClient');
  expectTypeOf<CreateAllOptions['store']>().not.toHaveProperty('clientConfig');
  expectTypeOf<CreateAllOptions['history']>().not.toHaveProperty('clientConfig');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- public-api.test.ts`
Expected: FAIL — `clientConfig`/`createClient` are currently present on the type.

- [ ] **Step 3: Implement the fix**

In `src/factory/factory.ts`:

```ts
/** Per-adapter options for {@link DynamoDBFactory.createAll} (client is shared). */
export interface CreateAllOptions {
  saver: Omit<DynamoDBSaverOptions, 'client' | 'clientConfig' | 'createClient'>;
  store: Omit<DynamoDBStoreOptions, 'client' | 'clientConfig' | 'createClient'>;
  history: Omit<DynamoDBChatMessageHistoryOptions, 'client' | 'clientConfig' | 'createClient'>;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- public-api.test.ts`
Expected: PASS

- [ ] **Step 5: Run full validation** (this fix can surface *new* compile errors anywhere in the codebase or its tests that were relying on the looser type — check for these specifically)

Run: `npm run typecheck && npm run lint && npm test`
Expected: PASS. If `typecheck` fails elsewhere, it means some test or example was passing `clientConfig`/`createClient` into `createAll()`'s options and relying on it being silently accepted — fix that call site to pass connection config via the factory's `base` options instead (the only place it's actually honored).

- [ ] **Step 6: Commit**

```bash
git add src/factory/factory.ts test/types/public-api.test.ts
git commit -m "fix(factory): exclude clientConfig/createClient from CreateAllOptions so misuse is a compile error"
```

---

## Task 14: Fix `listSessions` Scan iteration-cap exhaustion on shared tables

**Severity:** Low-medium — edge case, table-size-dependent, already partially flagged by the README's own Scan-cost warning.

**Confirmed bug:** `listSessions` (`src/history/actions/list-sessions.ts:13-21`) uses `paginateScan` with a `FilterExpression` and no `maxIterations` override. Re-verified against current AWS documentation (fetched live via the AWS documentation MCP tool): *"A filter expression is applied after a Scan finishes but before the results are returned... This limit [1MB] applies before the filter expression is evaluated."* So each of the default 1000 iterations can consume up to 1MB of **raw**, pre-filter table data — up to ~1GB scanned before `ResultTruncatedError` fires, regardless of how few actual sessions exist.

**Chosen mitigation (deliberately NOT the `Infinity` pattern used elsewhere):** a `Scan`'s cost scales with the *entire shared table*, unlike a `Query`, which scales with one partition — defaulting to `Infinity` here would turn a documented "rare, small" operation (README already warns "cost scales with table size... keep those rare or use a dedicated table") into a potential full-table-scan hang/cost bomb. Instead: keep the conservative default (fail fast with a clear error), and add an optional override so an operator on a busy shared table can deliberately raise it.

**Files:**
- Modify: `src/history/actions/list-sessions.ts`
- Modify: `src/history/chat-message-history.ts`
- Modify: `README.md` (cross-reference this failure mode next to the existing Scan-cost warning at line 325)
- Test: `test/unit/history/actions/list-sessions.test.ts`

**Interfaces:** `listSessions(context, options?: { maxIterations?: number }): Promise<SessionMetadata[]>` — new optional second parameter, backward compatible (existing zero-arg call sites keep working).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/history/actions/list-sessions.test.ts`, reusing the file's existing `session`/`context` helpers plus a new `ResultTruncatedError` import:

```ts
import { ResultTruncatedError } from '../../../../src/shared/errors/errors';

it('throws ResultTruncatedError by default when scan pages are exhausted by non-session filtering', async () => {
  const { client, mock } = createStrictDocumentMock();
  // Every page returns 0 post-filter items but always continues (simulating
  // a table dominated by non-session rows), for more than MAX_LOOP_ITERATIONS (1000) pages.
  for (let i = 0; i < 1001; i++) {
    mock.on(ScanCommand).resolvesOnce({ Items: [], LastEvaluatedKey: { PK: 'x', SK: String(i) } });
  }
  await expect(listSessions(context(client))).rejects.toThrow(ResultTruncatedError);
});

it('succeeds with a raised maxIterations override', async () => {
  const { client, mock } = createStrictDocumentMock();
  for (let i = 0; i < 1000; i++) {
    mock.on(ScanCommand).resolvesOnce({ Items: [], LastEvaluatedKey: { PK: 'x', SK: String(i) } });
  }
  mock
    .on(ScanCommand)
    .resolvesOnce({ Items: [session('s1', '2024-01-01')], LastEvaluatedKey: undefined });
  const result = await listSessions(context(client), { maxIterations: 2000 });
  expect(result.map((s) => s.sessionId)).toEqual(['s1']);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- list-sessions.test.ts`
Expected: first test currently passes (already throws by default — good, confirms baseline); second test FAILs (`listSessions` doesn't accept a second argument yet).

- [ ] **Step 3: Implement the fix**

In `src/history/actions/list-sessions.ts`:

```ts
export async function listSessions(
  context: HistoryContext,
  options?: { maxIterations?: number },
): Promise<SessionMetadata[]> {
  const sessions: SessionMetadata[] = [];
  for await (const raw of paginateScan({
    client: context.client,
    params: {
      TableName: context.tableName,
      FilterExpression: '#sk = :session',
      ExpressionAttributeNames: { '#sk': 'SK' },
      ExpressionAttributeValues: { ':session': SESSION_SORT_KEY },
    },
    maxIterations: options?.maxIterations,
  })) {
    // ...unchanged body...
  }
  sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return sessions;
}
```

In `src/history/chat-message-history.ts`, thread the optional parameter through the existing delegation method:

```ts
/** List all sessions as metadata summaries. */
listSessions(options?: { maxIterations?: number }): Promise<SessionMetadata[]> {
  return listSessionsAction(this.context, options);
}
```

In `README.md`, add a note next to the existing line 325 Scan-cost warning cross-referencing this: *"`listSessions` accepts an optional `{ maxIterations }` override for tables where non-session rows dominate the scan."*

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- list-sessions.test.ts`

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/history/actions/list-sessions.ts src/history/chat-message-history.ts README.md test/unit/history/actions/list-sessions.test.ts
git commit -m "feat(history): allow overriding listSessions' scan iteration cap for large shared tables"
```

---

## Task 15: S3 upload/download retry consistency (lowest priority)

**Severity:** Low — the AWS SDK v3's own default `standard` retry mode already applies to `S3Client` (confirmed via `docs.aws.amazon.com/sdkref`: 3 attempts, exponential backoff+jitter, retries transient/throttling/5xx/network errors), so framing this as "no retry" would be misleading. What's real: DynamoDB calls get a second, stacked app-level retry layer (`withDynamoDBRetry`, 5 attempts total with this codebase's own error classification) while S3 calls get only the SDK's single layer (3 attempts, generic classification) — an asymmetric resilience budget for two calls in the same logical operation. The codebase also already builds a bespoke S3 transient-error classifier (`isTransientS3Error`, `src/shared/codec/s3/orphans.ts:19-30`) but wires it only into orphan-cleanup deletes, not the primary upload/download path — an internal inconsistency worth closing, not a correctness bug.

**Confirmed implementation detail that changes the approach:** `orphans.ts` does **not** use the generic `withRetry`/`withDynamoDBRetry` primitive — it has its own bespoke backoff loop (`backoffSleep`/`nextBackoffDelay`) with a deliberately different contract (never throws, logs and returns on exhaustion, since orphan cleanup is best-effort). `withRetry` (`src/shared/dynamodb/retry.ts`) takes `retryableErrors?: readonly string[]` — a plain error-name/code substring list matched via `isRetryableError`, **not** a custom predicate function. `orphans.ts`'s local `RETRYABLE_S3_SIGNALS` (`SlowDown`, `InternalError`, `ServiceUnavailable`, `RequestTimeout`, `ThrottlingException`, `ECONNRESET`, `ETIMEDOUT`, `NetworkingError`) is exactly a string list of this shape, so it can be reused via `withRetry`'s existing `retryableErrors` option with **no changes needed to the retry engine itself** — only extracting that one constant.

**Files:**
- Modify: `src/shared/codec/s3/read-write.ts`
- New: `src/shared/codec/s3/retry.ts` (extract `RETRYABLE_S3_SIGNALS` and `isTransientS3Error` out of `orphans.ts`, unchanged, so both files share one definition)
- Modify: `src/shared/codec/s3/orphans.ts` (import both from the new file instead of defining them locally; its own bespoke retry loop is otherwise unchanged — it still needs `isTransientS3Error`'s httpStatusCode check, which `withRetry`'s plain string-list matching doesn't cover, so orphan cleanup keeps its own loop rather than switching to `withRetry`)
- Test: `test/unit/shared/codec/s3/read-write.test.ts`

**Interfaces:** `uploadObject`/`downloadObject` signatures unchanged. New exports from `src/shared/codec/s3/retry.ts`: `RETRYABLE_S3_SIGNALS: readonly string[]`, `isTransientS3Error(error: Error): boolean` (both moved verbatim from `orphans.ts`).

- [ ] **Step 1: Write the failing test**

Add to `test/unit/shared/codec/s3/read-write.test.ts`, reusing the file's existing pattern of constructing a plain `new S3Client({ region: 'us-east-1' })` per test (no ddb-mock needed here — this file mocks at the `S3Client` level directly via `s3Mock`):

```ts
it('retries a transient S3 error on upload', async () => {
  s3Mock
    .on(PutObjectCommand)
    .rejectsOnce(Object.assign(new Error('slow down'), { name: 'SlowDown' }))
    .resolves({});
  await uploadObject(new S3Client({ region: 'us-east-1' }), {
    bucket: 'b',
    key: 'k',
    data: new Uint8Array([1]),
  });
  expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(2);
});

it('does not retry a permanent S3 error on upload', async () => {
  s3Mock.on(PutObjectCommand).rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));
  await expect(
    uploadObject(new S3Client({ region: 'us-east-1' }), {
      bucket: 'b',
      key: 'k',
      data: new Uint8Array([1]),
    }),
  ).rejects.toThrow();
  expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(1);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- read-write.test.ts`
Expected: first test FAILs (only 1 call, no retry); second passes already (no retry means 1 call is already correct there — keep as a regression guard).

- [ ] **Step 3: Implement the fix**

Create `src/shared/codec/s3/retry.ts`, moving `RETRYABLE_S3_SIGNALS` and `isTransientS3Error` verbatim out of `orphans.ts`:

```ts
const RETRYABLE_S3_SIGNALS: readonly string[] = [
  'SlowDown',
  'InternalError',
  'ServiceUnavailable',
  'RequestTimeout',
  'ThrottlingException',
  'ECONNRESET',
  'ETIMEDOUT',
  'NetworkingError',
];

export { RETRYABLE_S3_SIGNALS };

/** True when `error` looks like a transient S3 failure worth retrying. */
export function isTransientS3Error(error: Error): boolean {
  const fields = error as { name?: string; code?: string; $metadata?: { httpStatusCode?: number } };
  const status = fields.$metadata?.httpStatusCode;
  if (typeof status === 'number' && (status === 429 || (status >= 500 && status < 600))) return true;
  const signals = [fields.name, fields.code].filter(
    (value): value is string => typeof value === 'string',
  );
  return signals.some((signal) =>
    RETRYABLE_S3_SIGNALS.some((retryable) => signal.includes(retryable)),
  );
}
```

Update `src/shared/codec/s3/orphans.ts`: delete its local `RETRYABLE_S3_SIGNALS` const and `isTransientS3Error` function, and add `import { isTransientS3Error } from './retry';` — its own bespoke backoff loop (`backoffSleep`, the `for` loop in `cleanUpS3Orphans`) is otherwise completely unchanged.

In `src/shared/codec/s3/read-write.ts`, wrap each `client.send(...)` call in `withRetry` using the extracted signal list directly as `retryableErrors` (no engine changes needed — `RETRYABLE_S3_SIGNALS` is already the exact shape `withRetry` expects):

```ts
import { withRetry } from '../../dynamodb/retry';
import { RETRYABLE_S3_SIGNALS } from './retry';

export async function uploadObject(client: S3Client, params: UploadParams): Promise<void> {
  const { PutObjectCommand } = await loadS3Sdk();
  try {
    await withRetry(
      () =>
        client.send(
          new PutObjectCommand({
            Bucket: params.bucket,
            Key: params.key,
            Body: params.data,
            ContentType: 'application/octet-stream',
            ServerSideEncryption: params.serverSideEncryption as ServerSideEncryption | undefined,
            ...(params.sseKmsKeyId ? { SSEKMSKeyId: params.sseKmsKeyId } : {}),
          }),
        ),
      { maxAttempts: 3, retryableErrors: RETRYABLE_S3_SIGNALS },
    );
  } catch (error) {
    throw wrapError(error as Error, ErrorCode.S3_OFFLOAD_FAILED, { operation: 'upload', key: params.key });
  }
}

export async function downloadObject(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Uint8Array> {
  const { GetObjectCommand } = await loadS3Sdk();
  try {
    return await withRetry(
      async () => {
        const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        if (!response.Body) {
          throw new Error(`S3 object body is empty for key: ${key}`);
        }
        return new Uint8Array(await response.Body.transformToByteArray());
      },
      { maxAttempts: 3, retryableErrors: RETRYABLE_S3_SIGNALS },
    );
  } catch (error) {
    throw wrapError(error as Error, ErrorCode.S3_OFFLOAD_FAILED, { operation: 'download', key });
  }
}
```

`maxAttempts: 3` is deliberately lower than `withDynamoDBRetry`'s default 5 — S3 payloads can be large, so blind retries are more expensive than a small DynamoDB item write; this matches the research's "modest, don't just copy DynamoDB's numbers" recommendation.

Note the empty-body check inside `downloadObject` now throws a plain `Error` (not S3/network-shaped) from *inside* the retried callback — that's intentional and correct: `isRetryableError`'s signal matching won't match a plain `Error('S3 object body is empty...')` against any of `RETRYABLE_S3_SIGNALS`, so `withRetry` will NOT retry it (an empty body is a data problem, not a transient failure) and it propagates on the first attempt, same as today's behavior.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- read-write.test.ts orphans.test.ts`
Expected: PASS, including the pre-existing `'wraps a failure as S3_OFFLOAD_FAILED'` and `'throws S3_OFFLOAD_FAILED when the body is empty'` tests unchanged — both use a plain `new Error(...)` with no retryable signal, so `withRetry` correctly fails them on the first attempt with no behavior change.

- [ ] **Step 5: Run full validation**

Run: `npm run typecheck && npm run lint && npm test`

- [ ] **Step 6: Commit**

```bash
git add src/shared/codec/s3/read-write.ts src/shared/codec/s3/retry.ts src/shared/codec/s3/orphans.ts test/unit/shared/codec/s3/read-write.test.ts
git commit -m "fix(s3): add app-level retry to upload/download, matching the DynamoDB call path's resilience budget"
```

---

## Execution Order & Notes

Tasks are ordered by severity (Critical → Low), but **Tasks 1–15 are independent of each other** (no task's implementation depends on another task's code changes — they touch disjoint files except where noted: Task 5 and Task 4 both touch `src/history/actions/`, and Task 9 touches the three adapter classes that Tasks 1/2 also touch indirectly via `S3Offloader`, but none share a function). This makes the set well-suited to `superpowers:subagent-driven-development` (one fresh subagent per task, reviewed between tasks) rather than requiring strict sequential execution — except that **Task 1 should land before Task 9**, since Task 9's README fix references S3 key behavior that Task 1 changes (a minor documentation-consistency dependency, not a code dependency).

Every task follows the same validation gate: `npm run typecheck && npm run lint && npm run build && npm test` must pass before moving to the next task, per this repo's own CI gate (`ci.yml`'s `test` job runs exactly these four checks). Do not run the Docker-dependent integration/conformance suite or any heavy command without asking first, per this session's standing instructions.