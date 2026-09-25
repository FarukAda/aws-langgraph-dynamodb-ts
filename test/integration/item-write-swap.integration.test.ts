// Proves the property the unit tests can only approximate: against a real
// DynamoDB, two writers that both observed the same revision cannot both
// commit, so exactly one previous payload is superseded and nothing is
// orphaned.

import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { DynamoDBStore } from '../../src/index';
import { type PayloadDescriptor, PayloadLocation } from '../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../src/shared/logging/logger';
import { putWithRevisionSwap } from '../../src/store/internal/item-write';
import {
  type ExistingRecordMeta,
  partitionKey,
  sortKey,
  type StoreItemRecord,
} from '../../src/store/internal/rows';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import { afterResponse } from './helpers/fault-injection';
import { MemoryS3 } from './helpers/memory-s3';

const tableName = 'item-write-swap-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let client: DynamoDBDocument;

beforeAll(async () => {
  await createTable(admin, tableName);
  client = DynamoDBDocument.from(new DynamoDBClient(DDB_LOCAL_CONFIG));
});

afterAll(async () => {
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('overwrite compare-and-swap', () => {
  it('admits only one of two writers holding the same observed revision', async () => {
    const pk = 'STORE#swap';
    const sk = 'k';
    await client.put({ TableName: tableName, Item: { PK: pk, SK: sk, rev: 'r0', value: 'v0' } });

    const attempt = (rev: string) =>
      client.put({
        TableName: tableName,
        Item: { PK: pk, SK: sk, rev, value: rev },
        ConditionExpression: '#rev = :rev',
        ExpressionAttributeNames: { '#rev': 'rev' },
        ExpressionAttributeValues: { ':rev': 'r0' },
      });

    const settled = await Promise.allSettled([attempt('rA'), attempt('rB')]);
    const rejected = settled.filter((r) => r.status === 'rejected');

    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.name).toBe('ConditionalCheckFailedException');
  });

  it('pins the absence of a revision on a row written before 0.9.0', async () => {
    const pk = 'STORE#legacy';
    const sk = 'k';
    await client.put({ TableName: tableName, Item: { PK: pk, SK: sk, value: 'v0' } });

    const guarded = () =>
      client.put({
        TableName: tableName,
        Item: { PK: pk, SK: sk, rev: 'r1', value: 'v1' },
        ConditionExpression: 'attribute_not_exists(#rev)',
        ExpressionAttributeNames: { '#rev': 'rev' },
      });

    await expect(guarded()).resolves.toBeDefined();
    // The row now carries a revision, so the same pre-upgrade observation loses.
    await expect(guarded()).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
  });

  // No S3 stand-in exists in this integration harness: docker-compose.yml
  // only runs DynamoDB Local (checked), and test/integration/helpers has no
  // S3/offloader fake (checked). Driving this case through DynamoDBStore.put()
  // with a real offloader is therefore impossible without inventing a
  // parallel harness. This instead calls putWithRevisionSwap -- the actual
  // compare-and-swap primitive that item-write.ts hands the offloader path to
  // -- directly against real DynamoDB, and pins the DynamoDB half of
  // the no-orphan invariant: whichever writer loses the immediate race
  // re-reads and reports having superseded the *other* writer's committed
  // descriptor, never the stale value it first observed and never its own.
  // That this returned descriptor is exactly what item-write.ts then deletes
  // from S3 is already proven against a mocked client by
  // test/unit/store/internal/item-write-swap.test.ts and
  // test/unit/store/actions/put.test.ts; this case's job is only to
  // prove the guarded put/re-read cycle those mocks assume actually behaves
  // that way against a real DynamoDB.
  it('supersedes exactly one payload per writer across a real concurrent compare-and-swap', async () => {
    const pk = 'STORE#swap-cas';
    const sk = 'k';
    const descriptor = (s3Key: string): PayloadDescriptor => ({
      location: PayloadLocation.S3,
      serdeType: 'json',
      compressed: false,
      s3Key,
    });
    const s3KeyOf = (meta: ExistingRecordMeta): string | undefined =>
      meta.value?.location === PayloadLocation.S3 ? meta.value.s3Key : undefined;
    const record = (rev: string): StoreItemRecord => ({
      PK: pk,
      SK: sk,
      namespace: ['swap-cas'],
      key: 'k',
      value: descriptor(rev),
      createdAt: 'T0',
      updatedAt: `T-${rev}`,
      rev,
    });

    const seed = descriptor('seed');
    await client.put({
      TableName: tableName,
      Item: {
        PK: pk,
        SK: sk,
        namespace: ['swap-cas'],
        key: 'k',
        value: seed,
        createdAt: 'T0',
        updatedAt: 'T0',
        rev: 'r0',
      },
    });
    const existing: ExistingRecordMeta = {
      exists: true,
      revision: 'r0',
      value: seed,
      createdAt: 'T0',
    };
    // Deliberately minimal: putWithRevisionSwap reads tableName, client,
    // logger and retry off its context, and hands that same context to the
    // tokened write as its deps -- never offloader or index, because the
    // choice of write shape is the descriptor's. These records carry an S3
    // descriptor, so this drives the transaction path against a real
    // DynamoDBDocument rather than a mock.
    const context = { tableName, offloader: {}, logger: SILENT_LOGGER, client };

    const [supersededA, supersededB] = await Promise.all([
      putWithRevisionSwap(context as never, record('A'), existing),
      putWithRevisionSwap(context as never, record('B'), existing),
    ]);

    // Exactly one call landed first (superseding the seed row); the other
    // lost that race, re-read, and must report the FIRST writer's own
    // descriptor as superseded -- never the seed (stale) and never its own.
    const aWentFirst = s3KeyOf(supersededA) === 'seed';
    const bWentFirst = s3KeyOf(supersededB) === 'seed';
    expect(aWentFirst).not.toBe(bWentFirst);

    const finalRow = await client.get({ TableName: tableName, Key: { PK: pk, SK: sk } });
    if (aWentFirst) {
      expect(supersededB.value).toEqual(descriptor('A'));
      expect(finalRow.Item?.rev).toBe('B');
    } else {
      expect(supersededA.value).toEqual(descriptor('B'));
      expect(finalRow.Item?.rev).toBe('A');
    }
  });

  /**
   * The fact the whole tokened write rests on, asserted at the tier that runs
   * in CI rather than inferred from a one-off probe: a re-sent transaction
   * whose first use was **applied** is answered from the idempotency cache,
   * not applied a second time. The interleaving is the real one - the write
   * lands, its acknowledgement is lost, a racing delete removes the row and
   * releases its object, and the identical request is retried into a
   * partition where the creation guard holds again. Without the cache that
   * retry recreates a row naming an object nobody will ever write again.
   */
  it('discards the re-send of a transaction whose acknowledgement was lost', async () => {
    const pk = 'STORE#token-reland';
    const sk = 'k';
    const input = {
      TransactItems: [
        {
          Put: {
            TableName: tableName,
            Item: { PK: pk, SK: sk, rev: 'A', value: 'A' },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        },
      ],
      ClientRequestToken: randomUUID(),
    };
    await client.transactWrite(input);
    /** Without this the whole test would still pass if the first call applied nothing. */
    const created = await client.get({ TableName: tableName, Key: { PK: pk, SK: sk } });
    expect(created.Item).toBeDefined();
    await client.delete({ TableName: tableName, Key: { PK: pk, SK: sk } });
    await client.transactWrite(input);
    const after = await client.get({
      TableName: tableName,
      Key: { PK: pk, SK: sk },
      ConsistentRead: true,
    });
    expect(after.Item).toBeUndefined();
  });

  /**
   * The composition, not the service fact: `store.put` itself, a write that
   * commits and whose acknowledgement is then lost, a concurrent delete that
   * removes the row it wrote, and the library's own retry re-sending the
   * identical tokened request. The row must stay deleted.
   *
   * Without the token the retry is a fresh conditional put, the creation guard
   * holds again now the row is gone, and the put resurrects a row the caller
   * had every reason to believe was deleted - carrying a payload id nothing
   * will ever write again.
   */
  it('does not resurrect a row a concurrent delete removed while its put was in flight', async () => {
    const namespace = ['reland'];
    const key = 'k';
    const rowKey = { PK: partitionKey(namespace), SK: sortKey(namespace, key) };
    const base = new DynamoDBClient({ ...DDB_LOCAL_CONFIG, maxAttempts: 1 });
    afterResponse(base, 'TransactWriteItemsCommand', async () => {
      await client.delete({ TableName: tableName, Key: rowKey });
      throw Object.assign(new Error('simulated lost response'), { name: 'ETIMEDOUT' });
    });
    const store = new DynamoDBStore({
      tableName,
      client: DynamoDBDocument.from(base),
      logger: SILENT_LOGGER,
      s3: { bucketName: 'memory', thresholdBytes: 1, createS3Client: () => new MemoryS3() },
    });

    await store.put(namespace, key, { pad: 'p'.repeat(600) });

    const after = await client.get({ TableName: tableName, Key: rowKey, ConsistentRead: true });
    expect(after.Item).toBeUndefined();
    store.destroy();
    base.destroy();
  });
});
