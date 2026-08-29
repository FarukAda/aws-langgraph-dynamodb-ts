// Proves the property the unit tests can only approximate: against a real
// DynamoDB, two writers that both observed the same revision cannot both
// commit, so exactly one previous payload is superseded and nothing is
// orphaned.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { type PayloadDescriptor, PayloadLocation } from '../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../src/shared/logging/logger';
import { putWithRevisionSwap } from '../../src/store/internal/overwrite-swap';
import type { ExistingRecordMeta } from '../../src/store/internal/read-existing';
import type { StoreItemRecord } from '../../src/store/types';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';

const tableName = 'overwrite-swap-itest';
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

describe('overwrite compare-and-swap (F5)', () => {
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
    expect((rejected[0] as PromiseRejectedResult).reason.name).toBe(
      'ConditionalCheckFailedException',
    );
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
  // parallel harness, which the task brief forbids. Per the brief's
  // implementer note, this instead calls putWithRevisionSwap -- the actual
  // Task 9 compare-and-swap primitive that persist.ts hands the offloader
  // path to -- directly against real DynamoDB, and pins the DynamoDB half of
  // the no-orphan invariant: whichever writer loses the immediate race
  // re-reads and reports having superseded the *other* writer's committed
  // descriptor, never the stale value it first observed and never its own.
  // That this returned descriptor is exactly what persist.ts then deletes
  // from S3 is already proven against a mocked client by
  // test/unit/store/internal/overwrite-swap.test.ts and
  // test/unit/store/internal/persist.test.ts; this case's job is only to
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
    // Deliberately minimal: putWithRevisionSwap only ever reads tableName,
    // client, and logger off its context (never offloader, index, etc.), so
    // this mirrors the shape test/unit/store/internal/overwrite-swap.test.ts
    // already relies on -- but with a real DynamoDBDocument instead of a mock.
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
});
