import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver, DynamoDBStore, ErrorCode, type Logger } from '../../src/index';
import { OVERWRITE_CAS_MAX_ATTEMPTS } from '../../src/shared/dynamodb/conditional-put';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import { awsError, installFaults } from './helpers/fault-injection';
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
  installFaults(base, rules);
  return { client: DynamoDBDocument.from(base), base };
}

async function expectNoDanglingReference(): Promise<void> {
  const referenced = await referencedS3Keys(reader, tableName);
  expect(referenced.filter((key) => !s3.keys().includes(key))).toEqual([]);
}

describe('compare-and-swap exhaustion falls back to an unconditional write (TEST-02)', () => {
  it('store.put overwrites after OVERWRITE_CAS_MAX_ATTEMPTS rejections, warns, and keeps the row consistent', async () => {
    const logger = recordingLogger();
    const { client, base } = faultyClient([
      {
        match: (name, input) =>
          name === 'PutItemCommand' &&
          (input as { ConditionExpression?: string }).ConditionExpression !== undefined &&
          (input as { Item?: { rev?: string } }).Item?.rev !== undefined,
        fail: () => awsError('ConditionalCheckFailedException'),
        times: OVERWRITE_CAS_MAX_ATTEMPTS,
      },
    ]);
    const store = new DynamoDBStore({ tableName, client, s3: offload, logger });
    await store.put(['cas'], 'k', { v: 0, pad: 'p'.repeat(600) });
    expect(logger.warnings.some((message) => message.includes('compare-and-swap exhausted'))).toBe(
      false,
    );
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
        match: (name, input) =>
          name === 'PutItemCommand' &&
          (input as { ConditionExpression?: string }).ConditionExpression !== undefined &&
          ((input as { Item?: { index?: number } }).Item?.index ?? 0) < 0,
        fail: () => awsError('ConditionalCheckFailedException'),
        times: OVERWRITE_CAS_MAX_ATTEMPTS,
      },
    ]);
    const saver = new DynamoDBSaver({ tableName, client, s3: offload, logger });
    const config = {
      configurable: { thread_id: 'cas-thread', checkpoint_ns: '', checkpoint_id: 'cp-1' },
    };
    const checkpoint: Checkpoint = {
      v: 4,
      id: 'cp-1',
      ts: new Date(0).toISOString(),
      channel_values: { blob: 'x'.repeat(600) },
      channel_versions: { blob: 1 },
      versions_seen: {},
    };
    const metadata: CheckpointMetadata = { source: 'loop', step: 1, parents: {} };
    await saver.put(
      { configurable: { thread_id: 'cas-thread', checkpoint_ns: '' } },
      checkpoint,
      metadata,
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

describe('an injected client that keeps the SDK retries multiplies the attempt budget (TEST-13)', () => {
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
