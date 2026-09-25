import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { partitionKey, writeSortKeyPrefix } from '../../src/checkpointer/internal/rows';
import { DynamoDBSaver, DynamoDBStore, ErrorCode, type Logger } from '../../src/index';
import { OVERWRITE_CAS_MAX_ATTEMPTS } from '../../src/shared/dynamodb/idempotent-write';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import {
  afterResponse,
  awsError,
  installFaults,
  transactionCanceled,
} from './helpers/fault-injection';
import { MemoryS3 } from './helpers/memory-s3';
import { referencedS3Keys } from './helpers/referenced-keys';

const tableName = 'cas-exhaustion-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
const reader = DynamoDBDocument.from(admin);
const s3 = new MemoryS3();
const offload = { bucketName: 'memory', thresholdBytes: 1, createS3Client: () => s3 };

beforeAll(() => createTable(admin, tableName));
afterAll(async () => {
  await deleteTable(admin, tableName);
  admin.destroy();
});

/**
 * A guarded store put, whichever shape it takes. An offloaded payload now goes
 * out as a one-item transaction under a client request token, so a matcher that
 * names only `PutItemCommand` stops matching and the fault it injects never
 * fires - the failure reads as "the compare-and-swap never exhausted" rather
 * than as "the test is looking for the wrong command".
 */
function isGuardedStorePut(name: string, input: unknown): boolean {
  const guarded = (put?: { ConditionExpression?: string; Item?: { rev?: string } }): boolean =>
    put?.ConditionExpression !== undefined && put?.Item?.rev !== undefined;
  if (name === 'PutItemCommand') return guarded(input as Parameters<typeof guarded>[0]);
  if (name !== 'TransactWriteItemsCommand') return false;
  const items = (input as { TransactItems?: { Put?: Parameters<typeof guarded>[0] }[] })
    .TransactItems;
  return items?.length === 1 && guarded(items[0].Put);
}

/**
 * A guarded special (negative-index) checkpointer write, whichever shape it
 * takes, and the mirror of {@link isGuardedStorePut}. An offloaded pending
 * write now goes out as a one-item transaction under a client request token, so
 * a matcher naming only `PutItemCommand` stops matching and the fault it
 * injects never fires - the failure then reads as "the compare-and-swap never
 * exhausted" rather than as "the test is looking for the wrong command".
 *
 * The negative index is what separates a special write from a regular one,
 * whose first-write-wins guard is otherwise identical on a row that does not
 * exist yet.
 */
function isGuardedSpecialWrite(name: string, input: unknown): boolean {
  const guarded = (put?: { ConditionExpression?: string; Item?: { index?: number } }): boolean =>
    put?.ConditionExpression !== undefined && (put?.Item?.index ?? 0) < 0;
  if (name === 'PutItemCommand') return guarded(input as Parameters<typeof guarded>[0]);
  if (name !== 'TransactWriteItemsCommand') return false;
  const items = (input as { TransactItems?: { Put?: Parameters<typeof guarded>[0] }[] })
    .TransactItems;
  return items?.length === 1 && guarded(items[0].Put);
}

/** Refuse each shape the way the service really refuses it; see the store rule's note. */
const refuseGuard = (commandName: string): Error =>
  commandName === 'TransactWriteItemsCommand'
    ? transactionCanceled(['ConditionalCheckFailed'])
    : awsError('ConditionalCheckFailedException');

/** A logger that records `warn` calls and stays silent otherwise. */
function recordingLogger(): Logger & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    warnings,
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: (message) => {
      warnings.push(message);
    },
  };
}

/** A document client over a fresh single-attempt base client with `rules` installed. */
function faultyClient(rules: Parameters<typeof installFaults>[1]): {
  client: DynamoDBDocument;
  base: DynamoDBClient;
} {
  const base = new DynamoDBClient({ ...DDB_LOCAL_CONFIG, maxAttempts: 1 });
  /** The middleware may be installed only once per client; a test that seeds first installs its rules itself. */
  if (rules.length > 0) installFaults(base, rules);
  return { client: DynamoDBDocument.from(base), base };
}

async function expectNoDanglingReference(): Promise<void> {
  const referenced = await referencedS3Keys(reader, tableName);
  expect(referenced.filter((key) => !s3.keys().includes(key))).toEqual([]);
}

/** A checkpoint whose one channel value is far past the offload threshold. */
const offloadedCheckpoint = (id: string): Checkpoint => ({
  v: 4,
  id,
  ts: new Date(0).toISOString(),
  channel_values: { blob: 'x'.repeat(600) },
  channel_versions: { blob: 1 },
  versions_seen: {},
});

const METADATA: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };

/** A pending-write value large enough that its payload is offloaded. */
const INTERRUPT_VALUE = { value: 'i'.repeat(600) };

/** The pending-write rows one checkpoint holds, read strongly consistently. */
async function writeRows(threadId: string, checkpointId: string) {
  const page = await reader.query({
    TableName: tableName,
    KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
    ExpressionAttributeValues: {
      ':pk': partitionKey(threadId),
      ':sk': writeSortKeyPrefix('', checkpointId),
    },
    ConsistentRead: true,
  });
  return page.Items ?? [];
}

/**
 * Remove one checkpoint's pending-write rows and release the objects they
 * named - what a losing call's cleanup does to a row it has proved is not the
 * live one, and the half of the race that makes a re-landed write fatal rather
 * than merely redundant.
 */
async function releaseWriteRows(threadId: string, checkpointId: string): Promise<void> {
  for (const row of await writeRows(threadId, checkpointId)) {
    await reader.delete({ TableName: tableName, Key: { PK: row.PK, SK: row.SK } });
    const descriptor = row.value as { s3Key?: string } | undefined;
    if (descriptor?.s3Key) s3.objects.delete(descriptor.s3Key);
  }
}

/** Drop the response of the next transaction, after `hook` has run against the row it wrote. */
function loseAcknowledgement(base: DynamoDBClient, hook: () => Promise<void>): void {
  afterResponse(base, 'TransactWriteItemsCommand', async () => {
    await hook();
    throw Object.assign(new Error('simulated lost response'), { name: 'ETIMEDOUT' });
  });
}

describe('compare-and-swap exhaustion falls back to an unconditional write', () => {
  it('store.put overwrites after OVERWRITE_CAS_MAX_ATTEMPTS rejections, warns, and keeps the row consistent', async () => {
    const logger = recordingLogger();
    const { client, base } = faultyClient([]);
    const store = new DynamoDBStore({ tableName, client, s3: offload, logger });
    await store.put(['cas'], 'k', { v: 0, pad: 'p'.repeat(600) });
    expect(logger.warnings.some((message) => message.includes('compare-and-swap exhausted'))).toBe(
      false,
    );
    /** Installed after the seed put, so only the overwrite's guarded puts are rejected. */
    installFaults(base, [
      {
        match: isGuardedStorePut,
        /**
         * Each shape is refused with the name and reason code the service
         * uses: a transaction loses its guard as a cancellation carrying one
         * `ConditionalCheckFailed` reason, never as the bare exception a
         * `PutItem` answers with, and injecting the bare one here would
         * exhaust the swap through a shape this path can no longer produce.
         * Neither arm attaches the rejected row, although the guard asks for
         * it, so the swap takes its read fallback on every attempt - which is
         * deliberate here (the exhaustion path is the subject) and is why the
         * re-pin-from-the-cancellation branch is pinned at the unit tier
         * instead.
         */
        fail: refuseGuard,
        times: OVERWRITE_CAS_MAX_ATTEMPTS,
      },
    ]);
    await store.put(['cas'], 'k', { v: 1, pad: 'p'.repeat(600) });
    expect(logger.warnings.some((message) => message.includes('compare-and-swap exhausted'))).toBe(
      true,
    );
    expect((await store.get(['cas'], 'k'))?.value).toMatchObject({ v: 1 });
    await expectNoDanglingReference();
    store.destroy();
    base.destroy();
  });

  it('a special putWrites overwrites after exhaustion and the write stays readable', async () => {
    const logger = recordingLogger();
    const { client, base } = faultyClient([
      {
        match: isGuardedSpecialWrite,
        fail: refuseGuard,
        times: OVERWRITE_CAS_MAX_ATTEMPTS,
      },
    ]);
    const saver = new DynamoDBSaver({ tableName, client, s3: offload, logger });
    const config = {
      configurable: { thread_id: 'cas-thread', checkpoint_ns: '', checkpoint_id: 'cp-1' },
    };
    await saver.put(
      { configurable: { thread_id: 'cas-thread', checkpoint_ns: '' } },
      offloadedCheckpoint('cp-1'),
      METADATA,
    );
    await saver.putWrites(config, [['__interrupt__', { value: 'first'.repeat(200) }]], 'task-1');
    await saver.putWrites(config, [['__interrupt__', { value: 'second'.repeat(200) }]], 'task-1');
    expect(
      logger.warnings.some((message) =>
        message.includes('special-write compare-and-swap exhausted'),
      ),
    ).toBe(true);
    const tuple = await saver.getTuple(config);
    expect(tuple?.pendingWrites?.map(([, channel]) => channel)).toEqual(['__interrupt__']);
    await expectNoDanglingReference();
    saver.destroy();
    base.destroy();
  });
});

describe('an injected client that keeps the SDK retries multiplies the attempt budget', () => {
  it('counts library × SDK attempts for a throttled GetItem and warns at construction', async () => {
    const SDK_ATTEMPTS = 3;
    const LIBRARY_ATTEMPTS = 2;
    const base = new DynamoDBClient({ ...DDB_LOCAL_CONFIG, maxAttempts: SDK_ATTEMPTS });
    let attempts = 0;
    /** Installed after the SDK retryer, so every SDK attempt passes through and is throttled. */
    base.middlewareStack.add(
      (next, context) => async (args) => {
        if ((context as { commandName?: string }).commandName !== 'GetItemCommand')
          return next(args);
        attempts += 1;
        throw Object.assign(new Error('Rate exceeded'), {
          name: 'ThrottlingException',
          $fault: 'client',
          $retryable: { throttling: true },
          $metadata: { httpStatusCode: 400 },
        });
      },
      { step: 'finalizeRequest', priority: 'low', name: 'throttle-after-sdk-retry' },
    );
    const logger = recordingLogger();
    const store = new DynamoDBStore({
      tableName,
      client: DynamoDBDocument.from(base),
      logger,
      retry: { maxAttempts: LIBRARY_ATTEMPTS, baseDelayMs: 1, maxDelayMs: 1 },
    });
    await expect(store.get(['stacked'], 'k')).rejects.toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
    });
    expect(attempts).toBe(LIBRARY_ATTEMPTS * SDK_ATTEMPTS);
    expect(logger.warnings.some((message) => message.includes("keeps the SDK's own retries"))).toBe(
      true,
    );
    store.destroy();
    base.destroy();
  });
});

/**
 * The three writes this routes through the token helper, driven the way the
 * failure really arrives: the write commits, its acknowledgement is lost, and
 * the library re-sends the identical request. Inside the service's idempotency
 * window that re-send is discarded; without a token it is simply applied again,
 * which after a concurrent cleanup leaves a live row naming an object nobody
 * will ever write.
 */
describe('a special write whose acknowledgement is lost is not applied twice', () => {
  it('does not re-land the pinned write whose row a concurrent cleanup removed', async () => {
    const config = {
      configurable: { thread_id: 'reland-pinned', checkpoint_ns: '', checkpoint_id: 'cp-1' },
    };
    const { client, base } = faultyClient([]);
    loseAcknowledgement(base, () => releaseWriteRows('reland-pinned', 'cp-1'));
    const saver = new DynamoDBSaver({ tableName, client, s3: offload, logger: recordingLogger() });

    await saver.putWrites(config, [['__interrupt__', INTERRUPT_VALUE]], 'task-1');

    /** The creation guard holds again once the row is gone, so only the token refuses the re-send. */
    expect(await writeRows('reland-pinned', 'cp-1')).toEqual([]);
    await expectNoDanglingReference();
    saver.destroy();
    base.destroy();
  });

  it('does not re-apply the unconditional overwrite the exhausted swap falls back to', async () => {
    const logger = recordingLogger();
    const config = {
      configurable: { thread_id: 'reland-overwrite', checkpoint_ns: '', checkpoint_id: 'cp-1' },
    };
    const { client, base } = faultyClient([
      { match: isGuardedSpecialWrite, fail: refuseGuard, times: OVERWRITE_CAS_MAX_ATTEMPTS },
    ]);
    /**
     * Only the unconditional overwrite ever reaches a response: every guarded
     * attempt is refused at the middleware, so this drops the acknowledgement
     * of the one write with no condition to turn its own re-send away.
     */
    loseAcknowledgement(base, () => releaseWriteRows('reland-overwrite', 'cp-1'));
    const saver = new DynamoDBSaver({ tableName, client, s3: offload, logger });

    await saver.putWrites(config, [['__interrupt__', INTERRUPT_VALUE]], 'task-1');

    expect(
      logger.warnings.some((message) =>
        message.includes('special-write compare-and-swap exhausted'),
      ),
    ).toBe(true);
    expect(await writeRows('reland-overwrite', 'cp-1')).toEqual([]);
    await expectNoDanglingReference();
    saver.destroy();
    base.destroy();
  });

  it('leaves exactly one row, still readable, when only the acknowledgement was lost', async () => {
    const config = {
      configurable: { thread_id: 'reland-once', checkpoint_ns: '', checkpoint_id: 'cp-1' },
    };
    const { client, base } = faultyClient([]);
    const saver = new DynamoDBSaver({ tableName, client, s3: offload, logger: recordingLogger() });
    await saver.put(
      { configurable: { thread_id: 'reland-once', checkpoint_ns: '' } },
      offloadedCheckpoint('cp-1'),
      METADATA,
    );
    /** Installed after the checkpoint's own transaction, so only the write's is dropped. */
    loseAcknowledgement(base, async () => {});

    await saver.putWrites(config, [['__interrupt__', INTERRUPT_VALUE]], 'task-1');

    expect(await writeRows('reland-once', 'cp-1')).toHaveLength(1);
    const tuple = await saver.getTuple(config);
    expect(tuple?.pendingWrites?.map(([, channel]) => channel)).toEqual(['__interrupt__']);
    await expectNoDanglingReference();
    saver.destroy();
    base.destroy();
  });
});
