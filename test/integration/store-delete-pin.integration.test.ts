// Proves against a real DynamoDB what the unit tier can only approximate: a
// store delete removes the row the caller observed and nothing else. The
// condition turns away a racer, the request token discards a replay the
// service already applied, and a key with no row is never written to at all.
//
// Every case here fails on the *absence of the mechanism*, and each names the
// mutation that turns it red; none of them passes against an unconditional
// DeleteItem, which sends no transaction for the hooks to fire on.

import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { DynamoDBStore } from '../../src/index';
import { OVERWRITE_CAS_MAX_ATTEMPTS } from '../../src/shared/dynamodb/conditional-put';
import type { Logger } from '../../src/shared/logging/logger';
import { partitionKey, sortKey } from '../../src/store/internal/keys';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import { afterResponse, beforeRequest } from './helpers/fault-injection';
import { MemoryS3 } from './helpers/memory-s3';

const tableName = 'store-delete-pin-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
const reader = DynamoDBDocument.from(admin);
const s3 = new MemoryS3();
/** Every payload offloads, so whether a row's object was released is observable. */
const offload = { bucketName: 'memory', thresholdBytes: 1, createS3Client: () => s3 };
const pad = 'p'.repeat(600);

const warnings: string[] = [];
const collecting: Logger = {
  debug: () => {},
  info: () => {},
  error: () => {},
  warn: (message: string) => {
    warnings.push(message);
  },
};

/** The un-faulted store: it seeds every row and plays every racing writer. */
let seeder: DynamoDBStore;
/** Everything a test builds that holds a socket, released in `afterAll`. */
const disposables: { destroy: () => void }[] = [];

beforeAll(async () => {
  await createTable(admin, tableName);
  seeder = new DynamoDBStore({ tableName, clientConfig: DDB_LOCAL_CONFIG, s3: offload });
});

afterAll(async () => {
  seeder.destroy();
  /** An adapter's `destroy()` deliberately leaves a caller-supplied client alone. */
  for (const disposable of disposables) disposable.destroy();
  disposables.length = 0;
  await deleteTable(admin, tableName);
  admin.destroy();
});

beforeEach(() => {
  warnings.length = 0;
});

const keyOf = (namespace: string[], key: string) => ({
  PK: partitionKey(namespace),
  SK: sortKey(namespace, key),
});

/** The row as it stands, read strongly-consistently. */
async function rowOf(
  namespace: string[],
  key: string,
): Promise<Record<string, unknown> | undefined> {
  const result = await reader.get({
    TableName: tableName,
    Key: keyOf(namespace, key),
    ConsistentRead: true,
  });
  return result.Item;
}

/** The S3 key the stored row names, which is the object a delete must release. */
async function objectOf(namespace: string[], key: string): Promise<string> {
  const row = await rowOf(namespace, key);
  return (row?.value as { s3Key: string }).s3Key;
}

/** Give the row a revision no caller observed, which is what a racing write does to a pin. */
async function bumpRevision(namespace: string[], key: string): Promise<void> {
  await reader.update({
    TableName: tableName,
    Key: keyOf(namespace, key),
    UpdateExpression: 'SET #rev = :rev',
    ExpressionAttributeNames: { '#rev': 'rev' },
    ExpressionAttributeValues: { ':rev': randomUUID() },
  });
}

/** One delete transaction the store sent, reduced to what these cases assert on. */
interface SentDelete {
  token: string;
  condition?: string;
}

interface Sent {
  names: string[];
  deletes: SentDelete[];
}

/** The input shape both of those are read off, without naming a command class. */
interface RecordedInput {
  ClientRequestToken?: string;
  TransactItems?: { Delete?: { ConditionExpression?: string } }[];
}

/** Record every command a client sends, and the shape of each delete transaction. */
function recordCommands(base: DynamoDBClient): Sent {
  const sent: Sent = { names: [], deletes: [] };
  base.middlewareStack.add(
    (next, context) => async (args) => {
      sent.names.push((context as { commandName?: string }).commandName ?? '');
      const input = (args as { input: RecordedInput }).input;
      const item = input.TransactItems?.[0]?.Delete;
      if (item) {
        sent.deletes.push({
          token: String(input.ClientRequestToken),
          condition: item.ConditionExpression,
        });
      }
      return next(args);
    },
    { step: 'initialize', name: 'record-commands' },
  );
  return sent;
}

/** A store on a fresh single-attempt client, its commands recorded and `configure` installed. */
function faultyStore(
  configure: (base: DynamoDBClient) => void,
  withS3 = true,
): { store: DynamoDBStore; sent: Sent } {
  const base = new DynamoDBClient({ ...DDB_LOCAL_CONFIG, maxAttempts: 1 });
  const sent = recordCommands(base);
  configure(base);
  const store = new DynamoDBStore({
    tableName,
    client: DynamoDBDocument.from(base),
    logger: collecting,
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
    ...(withS3 ? { s3: offload } : {}),
  });
  disposables.push(base, store);
  return { store, sent };
}

/** The transport failure a committed write whose acknowledgement never arrived looks like. */
const lostResponse = (): Error =>
  Object.assign(new Error('simulated lost response'), { name: 'ETIMEDOUT' });

describe('a delete whose acknowledgement is lost (D1)', () => {
  /**
   * Red without the request token: the retry re-evaluates its condition, finds
   * the revision the racer stamped, re-pins onto it and erases the row that
   * racer was told it had written — which is the erasure this whole path
   * exists to prevent. Red also if the object to release is read back from the
   * response, because this interleaving is precisely the one that loses it.
   */
  it('discards the replay and leaves the put that landed during the call alone', async () => {
    const namespace = ['lost-ack'];
    await seeder.put(namespace, 'k', { marker: 'original', pad });
    const original = await objectOf(namespace, 'k');
    const { store } = faultyStore((base) =>
      afterResponse(base, 'TransactWriteItemsCommand', async () => {
        await seeder.put(namespace, 'k', { marker: 'racer', pad });
        throw lostResponse();
      }),
    );

    await expect(store.delete(namespace, 'k')).resolves.toBeUndefined();

    expect((await seeder.get(namespace, 'k'))?.value).toMatchObject({ marker: 'racer' });
    /** The pre-read's object is released; HEAD leaked it with the lost response. */
    expect(s3.keys()).not.toContain(original);
    expect(s3.keys()).toContain(await objectOf(namespace, 'k'));
  });

  /**
   * The same interleaving with no `s3` at all, which is why the pin is not
   * scoped to offloaded rows the way the write side scopes its token: an
   * inline row loses an acknowledged write just as completely, and is easier
   * to reach, because a racing put then carries no condition either.
   */
  it('discards the replay for an inline row too, which is why the pin is not scoped to S3', async () => {
    const namespace = ['lost-ack-inline'];
    const plain = new DynamoDBStore({ tableName, clientConfig: DDB_LOCAL_CONFIG });
    disposables.push(plain);
    await plain.put(namespace, 'k', { marker: 'original' });
    const { store } = faultyStore(
      (base) =>
        afterResponse(base, 'TransactWriteItemsCommand', async () => {
          await plain.put(namespace, 'k', { marker: 'racer' });
          throw lostResponse();
        }),
      false,
    );

    await expect(store.delete(namespace, 'k')).resolves.toBeUndefined();

    expect((await plain.get(namespace, 'k'))?.value).toMatchObject({ marker: 'racer' });
  });
});

describe('a write landing between the read and the delete', () => {
  /**
   * Red without the re-pin, which leaves the row in place and resolves as the
   * exhaustion case. Red too if the re-pin reads the cancellation's row
   * *without* unmarshalling it: every later condition then compares a revision
   * against an `{ S: … }` object, all three attempts are refused, and the call
   * reports the designed rare case while having given up on an ordinary race.
   */
  it('is refused, re-pinned from the cancellation and deleted on the second attempt', async () => {
    const namespace = ['contended'];
    await seeder.put(namespace, 'k', { marker: 'first', pad });
    const { store, sent } = faultyStore((base) =>
      beforeRequest(base, 'TransactWriteItemsCommand', async () => {
        await seeder.put(namespace, 'k', { marker: 'second', pad });
      }),
    );

    await expect(store.delete(namespace, 'k')).resolves.toBeUndefined();

    expect(await rowOf(namespace, 'k')).toBeUndefined();
    expect(sent.deletes).toHaveLength(2);
    /** A cancelled token reserves its parameters, so the re-pin must mint a new one. */
    expect(new Set(sent.deletes.map((one) => one.token)).size).toBe(2);
    /** One read: the rejection carried the row, so no second read was spent. */
    expect(sent.names.filter((name) => name === 'GetItemCommand')).toHaveLength(1);
  });
});

describe('a delete of a key with no row (D1 in miniature)', () => {
  /**
   * The cheapest possible proof that the short-circuit is a closure and not a
   * cost saving: no acknowledgement is lost, no S3 object is involved, and an
   * acknowledged put is still erased without it. Red the moment the pre-read's
   * verdict stops gating the write — an unconditional delete removes the put
   * outright, and a delete pinned on `attribute_not_exists(PK)` is refused by
   * it and then re-pins onto it and removes it on the second attempt.
   */
  it('sends no write at all, and the put that lands during the call survives', async () => {
    const namespace = ['absent'];
    const { store, sent } = faultyStore((base) =>
      afterResponse(base, 'GetItemCommand', async () => {
        await seeder.put(namespace, 'k', { marker: 'arrived-mid-call', pad });
      }),
    );

    await expect(store.delete(namespace, 'k')).resolves.toBeUndefined();

    expect((await seeder.get(namespace, 'k'))?.value).toMatchObject({
      marker: 'arrived-mid-call',
    });
    /** One request, and it is a read: no DeleteItem and no transaction was sent. */
    expect(sent.names).toEqual(['GetItemCommand']);
    expect(s3.keys()).toContain(await objectOf(namespace, 'k'));
  });
});

describe('a row written before revisions existed', () => {
  /**
   * Red if the delete pins on anything the pre-read's projection does not
   * carry for such a row — `value.writeId`, say, which `read-existing` never
   * reads — because the condition then never holds, three refusals follow and
   * a table upgraded in place could never be emptied.
   */
  it('is deleted by pinning the absence of rev, and its object is released', async () => {
    const namespace = ['pre-rc2'];
    await seeder.put(namespace, 'k', { marker: 'legacy', pad });
    const object = await objectOf(namespace, 'k');
    await reader.update({
      TableName: tableName,
      Key: keyOf(namespace, 'k'),
      UpdateExpression: 'REMOVE #rev',
      ExpressionAttributeNames: { '#rev': 'rev' },
    });
    const { store, sent } = faultyStore(() => {});

    await expect(store.delete(namespace, 'k')).resolves.toBeUndefined();

    expect(sent.deletes.map((one) => one.condition)).toEqual(['attribute_not_exists(#rev)']);
    expect(await rowOf(namespace, 'k')).toBeUndefined();
    expect(s3.keys()).not.toContain(object);
    expect(warnings.filter((line) => line.includes('compare-and-swap exhausted'))).toEqual([]);
  });
});

describe('three writers winning in a row', () => {
  /**
   * The one outcome this change adds, driven by real refusals rather than
   * injected ones: a competing revision lands before *every* attempt, the two
   * that re-pin from a cancellation included — which is why the hook has to
   * run before the request, since those attempts issue no read to hook and
   * their own transactions come back as errors.
   *
   * Red if the loop is unbounded, if it falls back to an unconditional delete
   * the way the put side does — which would reopen the erasure on exactly this
   * path — or if a cancellation *carrying* a row is read as "already gone".
   * A failure showing one attempt rather than three would instead say the
   * local image does not attach the row to a delete's cancellation, which the
   * design takes as established.
   */
  it('resolves with the item still there, nothing released and exactly one warn', async () => {
    const namespace = ['exhausted'];
    await seeder.put(namespace, 'k', { marker: 'held', pad });
    const object = await objectOf(namespace, 'k');
    const { store, sent } = faultyStore((base) =>
      beforeRequest(
        base,
        'TransactWriteItemsCommand',
        () => bumpRevision(namespace, 'k'),
        OVERWRITE_CAS_MAX_ATTEMPTS,
      ),
    );

    await expect(store.delete(namespace, 'k')).resolves.toBeUndefined();

    expect(sent.deletes).toHaveLength(OVERWRITE_CAS_MAX_ATTEMPTS);
    expect(new Set(sent.deletes.map((one) => one.token)).size).toBe(OVERWRITE_CAS_MAX_ATTEMPTS);
    /** The item is still there, and the object it still names was not released. */
    expect(await rowOf(namespace, 'k')).toBeDefined();
    expect(s3.keys()).toContain(object);
    expect(
      warnings.filter((line) => line.includes('store.delete: compare-and-swap exhausted')),
    ).toHaveLength(1);
  });
});

describe('store.batch routes a null value through the same delete', () => {
  /**
   * Red if `batch` ever grows a delete of its own: the pin, the token and the
   * release belong to this one path, and both public routes reach it.
   */
  it('removes the observed row under a pinned, tokened transaction and releases its object', async () => {
    const namespace = ['batched'];
    await seeder.put(namespace, 'k', { marker: 'batch', pad });
    const object = await objectOf(namespace, 'k');
    const { store, sent } = faultyStore(() => {});

    await store.batch([{ namespace, key: 'k', value: null }]);

    expect(sent.deletes).toHaveLength(1);
    expect(sent.deletes[0].condition).toBe('#rev = :rev');
    expect(sent.deletes[0].token).toHaveLength(36);
    expect(await rowOf(namespace, 'k')).toBeUndefined();
    expect(s3.keys()).not.toContain(object);
  });
});
