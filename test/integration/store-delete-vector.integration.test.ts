// Proves against a real DynamoDB what the unit tier can only approximate: a
// store delete never clears the vector of an item that is still there, and an
// item whose row really is gone still loses its vector.
//
// Two interleavings reach the same defect from different directions - a put
// that recreates the row mid-delete, and a compare-and-swap that gives up and
// leaves the row alone - and both used to end with `backend.delete`. The
// symptom is the one a caller reports: `get` returns the item, `search` does
// not, until `reconcileVectorIndex` runs.
//
// Every case names the mutation that turns it red, and none of them passes
// against an ungated vector delete.

import { randomUUID } from 'node:crypto';

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import {
  DynamoDBStore,
  type VectorBackend,
  type VectorMatch,
  type VectorRef,
} from '../../src/index';
import { OVERWRITE_CAS_MAX_ATTEMPTS } from '../../src/shared/dynamodb/conditional-put';
import { SILENT_LOGGER } from '../../src/shared/logging/logger';
import { partitionKey, sortKey } from '../../src/store/internal/keys';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';
import { FakeEmbeddings } from './helpers/fake-embeddings';
import { afterResponse, beforeRequest } from './helpers/fault-injection';

/**
 * An in-memory backend that records every delete it is *asked* for, not only
 * the ones that removed something. A gate is proved by the calls that never
 * happen, so a backend that silently no-ops an unknown key would hide exactly
 * the failure these cases exist to catch.
 */
class RecordingBackend implements VectorBackend {
  readonly vectors = new Map<string, VectorRef>();
  readonly deleted: string[] = [];

  private id(namespace: string[], key: string): string {
    return `${namespace.join('/')}/${key}`;
  }

  /**
   * `VectorBackend` methods are typed `Promise<...>`; every body below is
   * synchronous. Each `await Promise.resolve()` resolves an already-resolved
   * value — it costs one microtask and changes nothing a caller can observe —
   * and keeps the method a real `async` function whose return type still
   * matches the interface.
   */
  async upsert(namespace: string[], key: string): Promise<void> {
    this.vectors.set(this.id(namespace, key), { namespace, key });
    await Promise.resolve();
  }

  async query(prefix: string[], _vector: number[], topK: number): Promise<VectorMatch[]> {
    await Promise.resolve();
    const head = prefix.join('/');
    return [...this.vectors.values()]
      .filter((ref) => ref.namespace.join('/').startsWith(head))
      .slice(0, topK)
      .map((ref) => ({ namespace: ref.namespace, key: ref.key, score: 1 }));
  }

  async delete(namespace: string[], key: string): Promise<void> {
    this.deleted.push(this.id(namespace, key));
    this.vectors.delete(this.id(namespace, key));
    await Promise.resolve();
  }
}

const tableName = 'store-delete-vector-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
const reader = DynamoDBDocument.from(admin);
const backend = new RecordingBackend();
const index = { dims: 8, embeddings: new FakeEmbeddings() as never };
const TEXT = 'hello world';

/** The un-faulted store: it seeds every row, plays every racing writer and runs every search. */
let seeder: DynamoDBStore;
/** Everything a test builds that holds a socket, released in `afterAll`. */
const disposables: { destroy: () => void }[] = [];

beforeAll(async () => {
  await createTable(admin, tableName);
  seeder = new DynamoDBStore({
    tableName,
    clientConfig: DDB_LOCAL_CONFIG,
    index,
    vectorBackend: backend,
  });
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
  backend.deleted.length = 0;
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

/** What a case can observe of one store's own run, besides the backend it shares. */
interface StoreProbe {
  store: DynamoDBStore;
  warnings: string[];
  writes: number;
}

/** A store on a fresh single-attempt client sharing the one backend, with `configure` installed. */
function faultyStore(configure: (base: DynamoDBClient) => void): StoreProbe {
  const base = new DynamoDBClient({ ...DDB_LOCAL_CONFIG, maxAttempts: 1 });
  configure(base);
  const probe: StoreProbe = { store: undefined as never, warnings: [], writes: 0 };
  base.middlewareStack.add(
    (next, context) => async (args) => {
      if ((context as { commandName?: string }).commandName === 'TransactWriteItemsCommand') {
        probe.writes += 1;
      }
      return next(args);
    },
    { step: 'initialize', name: 'count-writes' },
  );
  probe.store = new DynamoDBStore({
    tableName,
    client: DynamoDBDocument.from(base),
    index,
    vectorBackend: backend,
    logger: { ...SILENT_LOGGER, warn: (message: string) => probe.warnings.push(message) },
    retry: { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 },
  });
  disposables.push(base, probe.store);
  return probe;
}

/** The keys `search` finds under `namespace` for the text every case indexes. */
async function foundKeys(namespace: string[]): Promise<string[]> {
  const results = await seeder.search(namespace, { query: TEXT });
  return results.map((item) => item.key);
}

describe('a delete whose row really is gone', () => {
  /**
   * The control, and the case that keeps the gate honest: a confirmation that
   * never confirms anything would pass every other case here. Red if the gate
   * is inverted, or if a confirmation read that succeeds is read as "still
   * there".
   */
  it('drops the vector, and search stops finding the item', async () => {
    const namespace = ['plain'];
    await seeder.put(namespace, 'k', { text: TEXT });
    expect(await foundKeys(namespace)).toEqual(['k']);

    await seeder.delete(namespace, 'k');

    expect(backend.deleted).toEqual(['plain/k']);
    expect(await rowOf(namespace, 'k')).toBeUndefined();
    expect(await foundKeys(namespace)).toEqual([]);
  });
});

describe('a put that recreates the row during the delete', () => {
  /**
   * The original interleaving, and it needs no lost acknowledgement, no retry
   * and no S3: the row delete was correct - its condition held and the row it
   * observed really was removed - and everything that goes wrong happens after
   * it. The racing put commits a new row *and* upserts its vector; an ungated
   * `backend.delete` then wipes that fresh vector while the row stays live.
   *
   * Red without the confirmation read, and red too if the confirmation is
   * issued after the backend call rather than before it. A failure showing the
   * vector gone but the row absent would instead say the hook never fired.
   */
  it('keeps the vector, and search still finds the item', async () => {
    const namespace = ['recreated'];
    await seeder.put(namespace, 'k', { text: TEXT });
    const probe = faultyStore((base) =>
      afterResponse(base, 'TransactWriteItemsCommand', async () => {
        await seeder.put(namespace, 'k', { text: TEXT });
      }),
    );

    await expect(probe.store.delete(namespace, 'k')).resolves.toBeUndefined();

    expect(await rowOf(namespace, 'k')).toBeDefined();
    expect(backend.deleted).toEqual([]);
    expect(await foundKeys(namespace)).toEqual(['k']);
  });
});

describe('three writers winning in a row', () => {
  /**
   * The newer interleaving: the compare-and-swap is exhausted, so the call
   * resolves with the item still there and releases nothing - and used to clear
   * that live item's vector on the way out, so `search` stopped returning an
   * item `get` still returned. The hook runs before the request because the
   * attempts that re-pin from a cancellation issue no read to hook.
   *
   * Red if the vector delete runs on any path that did not confirm the row is
   * gone. A failure showing the row already absent would instead say the
   * competing revision did not land before every attempt.
   */
  it('keeps the vector of the item the delete left alone', async () => {
    const namespace = ['held'];
    await seeder.put(namespace, 'k', { text: TEXT });
    const probe = faultyStore((base) =>
      beforeRequest(
        base,
        'TransactWriteItemsCommand',
        () => bumpRevision(namespace, 'k'),
        OVERWRITE_CAS_MAX_ATTEMPTS,
      ),
    );

    await expect(probe.store.delete(namespace, 'k')).resolves.toBeUndefined();

    expect(await rowOf(namespace, 'k')).toBeDefined();
    /**
     * Without these two the case would still pass if the swap resolved on its
     * first rejection instead of exhausting - a cancellation that stopped
     * carrying its row reads as "already gone", the row is live either way, and
     * the gate would be proved on a path this case does not claim to test.
     */
    expect(probe.writes).toBe(OVERWRITE_CAS_MAX_ATTEMPTS);
    expect(probe.warnings).toContain(
      'store.delete: compare-and-swap exhausted; the item was not deleted',
    );
    expect(backend.deleted).toEqual([]);
    expect(await foundKeys(namespace)).toEqual(['k']);
  });
});

describe('a delete of a key that never had a row', () => {
  /**
   * The path a carve-out would have reopened. Clearing a stranded vector for a
   * key with no row is a repair callers have, so the delete still runs - but it
   * runs through the same confirmation, so a put landing after the pre-read
   * keeps its vector like any other live row.
   *
   * Red the moment the pre-read is allowed to double as the confirmation.
   */
  it('still confirms, so a put landing mid-call keeps its vector', async () => {
    const namespace = ['absent'];
    backend.vectors.set('absent/k', { namespace, key: 'k' });
    const probe = faultyStore((base) =>
      afterResponse(base, 'GetItemCommand', async () => {
        await seeder.put(namespace, 'k', { text: TEXT });
      }),
    );

    await expect(probe.store.delete(namespace, 'k')).resolves.toBeUndefined();

    /**
     * An empty `deleted` here means "confirmed, and kept" only while the repair
     * itself still exists: a regression that dropped the stranded-vector clear
     * on this path entirely would look identical. The sibling case below is what
     * tells the two apart, and the unit tier pins it directly.
     */
    expect(probe.writes).toBe(0);
    expect(backend.deleted).toEqual([]);
    expect(await foundKeys(namespace)).toEqual(['k']);
  });

  it('clears the stranded vector when nothing lands mid-call', async () => {
    const namespace = ['absent-quiet'];
    backend.vectors.set('absent-quiet/k', { namespace, key: 'k' });
    const probe = faultyStore(() => {});

    await expect(probe.store.delete(namespace, 'k')).resolves.toBeUndefined();

    expect(probe.writes).toBe(0);
    expect(backend.deleted).toEqual(['absent-quiet/k']);
  });
});
