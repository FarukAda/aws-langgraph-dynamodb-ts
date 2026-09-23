import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import type { DocItem } from '../../../../src/shared/dynamodb/types';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { deleteStoreItem } from '../../../../src/store/internal/delete-item';
import { parseStoreAddress } from '../../../../src/store/internal/parse';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { revisionGuardedTable } from '../../../shared/helpers/conditional-delete';
import { answerDeleteReads, createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const PK = 'STORE#users';
const SK = 'u1#profile';
const ROW_KEY = `${PK}|${SK}`;
const S3_KEY = 'users/u1/profile.bin';

const address = parseStoreAddress(['users', 'u1'], 'profile');

/** A whole row as the table holds it, offloaded so its release is observable. */
const row = (rev: string): DocItem => ({
  PK,
  SK,
  createdAt: 'T0',
  rev,
  value: { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key: S3_KEY },
});

/** The same row as the pre-read's projection returns it: no keys, no inline bytes. */
const projected = (item: DocItem): DocItem => ({
  createdAt: item.createdAt,
  rev: item.rev,
  value: { location: (item.value as DocItem).location, s3Key: (item.value as DocItem).s3Key },
});

/** What the confirmation read sees when the key holds a row: its `PK`, and nothing else. */
const stillThere: DocItem = { PK };

/** The failure a confirmation read that never reached the table comes back as. */
const readDown = (): Error =>
  Object.assign(new Error('read down'), { name: 'ValidationException' });

/**
 * A delete with an offloader, a vector backend and a recording logger. `order`
 * records which cleanup ran first and `reads` how many reads had been issued by
 * the time the vector was dropped, which is what tells a confirmation placed
 * *before* the backend call from one placed after it.
 */
function harness(withBackend = true) {
  const { client, mock } = createStrictDocumentMock();
  const order: string[] = [];
  const reads: number[] = [];
  const backend = {
    upsert: jest.fn(),
    query: jest.fn(),
    delete: jest.fn(() => {
      order.push('vector');
      reads.push(mock.commandCalls(GetCommand).length);
    }),
  };
  const offloader = {
    shouldOffload: () => true,
    buildKey: (parts: string[], objectId: string) => [...parts, objectId].join('/'),
    upload: (key: string) => key,
    deleteBatch: jest.fn(() => {
      order.push('s3');
      return [];
    }),
    ownsKey: () => true,
  };
  const info = jest.fn();
  const ctx: StoreContext = {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: { ...SILENT_LOGGER, info },
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    offloader: offloader as never,
    ...(withBackend ? { vectorBackend: backend as never } : {}),
  };
  return { mock, ctx, backend, order, reads, info };
}

const KEPT = 'store.delete: kept a vector whose item was not confirmed gone';

describe('the vector delete is gated on a confirmation that the row is gone', () => {
  it('drops the vector after one consistent PK read, and before the S3 cleanup', async () => {
    const h = harness();
    const table = revisionGuardedTable([row('r0')]);
    answerDeleteReads(h.mock, projected(row('r0')), undefined);
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, address)).resolves.toBeUndefined();

    expect(h.backend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
    expect(h.mock.commandCalls(GetCommand)[1].args[0].input).toEqual({
      TableName: 'store',
      Key: { PK, SK },
      ConsistentRead: true,
      ProjectionExpression: '#a0',
      ExpressionAttributeNames: { '#a0': 'PK' },
    });
    /** Both reads were spent before the backend was told anything. */
    expect(h.reads).toEqual([2]);
    /** The window is two adjacent statements, not a whole S3 round trip. */
    expect(h.order).toEqual(['vector', 's3']);
  });

  /**
   * The original interleaving: this call's own delete landed, and a put
   * committed a new row *and* its vector before the trailing backend call. The
   * row is live, so the vector stays; asserting the delete happened would prove
   * nothing about the gate, so this asserts it did not.
   */
  it('keeps the vector when a racing put recreated the row this call removed', async () => {
    const h = harness();
    const table = revisionGuardedTable([row('r0')]);
    answerDeleteReads(h.mock, projected(row('r0')), stillThere);
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, address)).resolves.toBeUndefined();

    expect(table.rows.size).toBe(0);
    expect(h.backend.delete).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(KEPT, { namespace: ['users', 'u1'], key: 'profile' });
  });

  /**
   * The newer one: the compare-and-swap is exhausted, so the call resolves with
   * the row still there. Before the gate it cleared that live row's vector, and
   * `search` stopped returning an item `get` still returned.
   */
  it('keeps the vector when the compare-and-swap is exhausted and left the row alone', async () => {
    const h = harness();
    const table = revisionGuardedTable([row('r1')], (attempt, rows) => {
      rows.set(ROW_KEY, row(`w${attempt}`));
    });
    answerDeleteReads(h.mock, projected(row('r0')), stillThere);
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, address)).resolves.toBeUndefined();

    expect(table.rows.size).toBe(1);
    expect(h.backend.delete).not.toHaveBeenCalled();
    expect(h.mock.commandCalls(GetCommand)).toHaveLength(2);
    expect(h.info).toHaveBeenCalledWith(KEPT, { namespace: ['users', 'u1'], key: 'profile' });
  });

  /**
   * A read that did not happen is not evidence. `rowIsAbsent` reports its own
   * failure as `false` - "not confirmed", never "still there" - so the vector
   * survives and `reconcileVectorIndex` clears it later. A stale vector for a
   * deleted item is recoverable; a missing one for a live item is the defect
   * this whole gate exists for.
   */
  it('keeps the vector when the confirmation read itself fails', async () => {
    const h = harness();
    const table = revisionGuardedTable([row('r0')]);
    h.mock.on(GetCommand).callsFake((input: { ProjectionExpression?: string }) => {
      if (String(input.ProjectionExpression).includes('#c')) return { Item: projected(row('r0')) };
      throw readDown();
    });
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, address)).resolves.toBeUndefined();

    expect(table.rows.size).toBe(0);
    expect(h.backend.delete).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(KEPT, { namespace: ['users', 'u1'], key: 'profile' });
  });
});

describe('the confirmation has no carve-out', () => {
  it('confirms a key that never had a row before clearing its stranded vector', async () => {
    const h = harness();
    answerDeleteReads(h.mock, undefined, undefined);

    await expect(deleteStoreItem(h.ctx, address)).resolves.toBeUndefined();

    /** No write at all, and still two reads: the pre-read does not double as the confirmation. */
    expect(h.mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(h.mock.commandCalls(GetCommand)).toHaveLength(2);
    expect(h.backend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
  });

  /**
   * The same short-circuit with a put landing during it, which is the path a
   * carve-out would have reopened: the pre-read found nothing, so letting it
   * stand as the confirmation would clear the vector of the row that arrived
   * after it.
   */
  it('keeps the vector when a put lands between the pre-read and the confirmation', async () => {
    const h = harness();
    answerDeleteReads(h.mock, undefined, stillThere);

    await expect(deleteStoreItem(h.ctx, address)).resolves.toBeUndefined();

    expect(h.backend.delete).not.toHaveBeenCalled();
    expect(h.info).toHaveBeenCalledWith(KEPT, { namespace: ['users', 'u1'], key: 'profile' });
  });

  it('spends no confirmation read when no vectorBackend is configured', async () => {
    const h = harness(false);
    const table = revisionGuardedTable([row('r0')]);
    answerDeleteReads(h.mock, projected(row('r0')), stillThere);
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, address)).resolves.toBeUndefined();

    expect(h.mock.commandCalls(GetCommand)).toHaveLength(1);
    expect(h.info).not.toHaveBeenCalled();
    expect(table.rows.size).toBe(0);
  });
});
