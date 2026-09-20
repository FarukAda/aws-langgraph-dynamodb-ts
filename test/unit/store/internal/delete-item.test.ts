import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';
import type { PutOperation } from '@langchain/langgraph-checkpoint';

import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import type { DocItem } from '../../../../src/shared/dynamodb/types';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { deleteStoreItem } from '../../../../src/store/internal/delete-item';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { revisionGuardedTable } from '../../../shared/helpers/conditional-delete';
import { answerDeleteReads, createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const PK = 'STORE#users';
const SK = 'u1#profile';
const ROW_KEY = `${PK}|${SK}`;

const op: PutOperation = { namespace: ['users', 'u1'], key: 'profile', value: null };

const throttled = (): Error =>
  Object.assign(new Error('slow down'), { name: 'ThrottlingException' });

/** The cancellation a guard rejection arrives as, carrying the row that turned it away. */
const rejectedWith = (item: DocItem): Error =>
  Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed', Item: marshall(item) }],
  });

/** A whole row as the table holds it, offloaded under `s3Key`. */
const row = (rev: string | undefined, s3Key = 'users/u1/profile.bin'): DocItem => ({
  PK,
  SK,
  createdAt: 'T0',
  value: { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key },
  ...(rev === undefined ? {} : { rev }),
});

/** The same row as the pre-read's projection returns it: no keys, no inline bytes. */
const projected = (item: DocItem): DocItem => ({
  createdAt: item.createdAt,
  value: { location: (item.value as DocItem).location, s3Key: (item.value as DocItem).s3Key },
  ...(item.rev === undefined ? {} : { rev: item.rev }),
});

function trackingOffloader() {
  return {
    shouldOffload: () => true,
    buildKey: (parts: string[], objectId: string) => [...parts, objectId].join('/'),
    upload: async (key: string) => key,
    deleteBatch: jest.fn().mockResolvedValue([]),
    ownsKey: () => true,
  };
}

function context(client: StoreContext['client'], extra?: Partial<StoreContext>): StoreContext {
  return {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
    retry: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    ...extra,
  };
}

type Mock = ReturnType<typeof createStrictDocumentMock>['mock'];

/** A delete with an offloader and a recording logger, so releases and warnings are observable. */
function harness(extra?: Partial<StoreContext>) {
  const { client, mock } = createStrictDocumentMock();
  const offloader = trackingOffloader();
  const warn = jest.fn();
  const ctx = context(client, {
    offloader: offloader as never,
    logger: { ...SILENT_LOGGER, warn },
    ...extra,
  });
  const released = (): string[] =>
    offloader.deleteBatch.mock.calls.flatMap(([keys]) => keys as string[]);
  return { mock, ctx, warn, released };
}

/** The one `Delete` the transaction at `index` carried. */
const sentDelete = (mock: Mock, index = 0) =>
  mock.commandCalls(TransactWriteCommand)[index].args[0].input.TransactItems![0].Delete!;

describe('deleteStoreItem deletes only the row the caller observed', () => {
  it('removes the observed row under one token and releases the object it named', async () => {
    const h = harness();
    const table = revisionGuardedTable([row('r0')]);
    answerDeleteReads(h.mock, projected(row('r0')));
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).resolves.toBeUndefined();

    expect(table.rows.size).toBe(0);
    expect(table.tokens).toHaveLength(1);
    expect(table.tokens[0]).toHaveLength(36);
    expect(sentDelete(h.mock)).toEqual({
      TableName: 'store',
      Key: { PK, SK },
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': 'rev' },
      ExpressionAttributeValues: { ':rev': 'r0' },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
    expect(h.released()).toEqual(['users/u1/profile.bin']);
  });

  /**
   * The second case this closes, and it needs no lost acknowledgement: an
   * unconditional delete erases a put that lands between the caller's call and
   * the write. The pre-read finds nothing, so no transaction is sent at all -
   * and the vector and S3 cleanup still run, because clearing a stranded vector
   * for a key with no row is a repair path callers have today.
   */
  it('sends no write when the pre-read finds no row, and still runs the trailing cleanup', async () => {
    const backend = { upsert: jest.fn(), query: jest.fn(), delete: jest.fn() };
    const h = harness({ vectorBackend: backend as never });
    const table = revisionGuardedTable([row('r0')]);
    answerDeleteReads(h.mock, undefined);
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).resolves.toBeUndefined();

    expect(h.mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(h.mock.calls()).toHaveLength(1);
    expect(table.rows.size).toBe(1);
    expect(backend.delete).toHaveBeenCalledWith(['users', 'u1'], 'profile');
    expect(h.released()).toEqual([]);
  });

  /**
   * The re-pin has to unmarshall the row the cancellation carried. Read raw it
   * yields a revision of `{ S: 'r1' }` where a string belongs, every later
   * condition compares against an object, and the call gives up on the
   * exhaustion path while reporting the designed rare case.
   */
  it('re-pins from the row the cancellation carried, under a fresh token, and still deletes', async () => {
    const h = harness();
    const table = revisionGuardedTable([row('r1', 'theirs.bin')]);
    answerDeleteReads(h.mock, projected(row('r0')));
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).resolves.toBeUndefined();

    expect(table.rows.size).toBe(0);
    expect(table.tokens).toHaveLength(2);
    expect(new Set(table.tokens).size).toBe(2);
    expect(sentDelete(h.mock, 1).ExpressionAttributeValues).toEqual({ ':rev': 'r1' });
    expect(h.released()).toEqual(['theirs.bin']);
    expect(h.mock.commandCalls(GetCommand)).toHaveLength(1);
  });

  it('resolves without deleting, releases nothing and warns once when three writers win in a row', async () => {
    const h = harness();
    const table = revisionGuardedTable([row('r1')], (attempt, rows) => {
      rows.set(ROW_KEY, row(`w${attempt}`));
    });
    answerDeleteReads(h.mock, projected(row('r0')));
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).resolves.toBeUndefined();

    expect(table.tokens).toHaveLength(3);
    expect(new Set(table.tokens).size).toBe(3);
    expect(table.rows.size).toBe(1);
    expect(h.released()).toEqual([]);
    expect(h.warn).toHaveBeenCalledTimes(1);
    expect(h.warn).toHaveBeenCalledWith(
      'store.delete: compare-and-swap exhausted; the item was not deleted',
      { namespace: ['users', 'u1'], key: 'profile', attempts: 3 },
    );
  });

  it('treats a rejection carrying no row as already gone and releases the last observation', async () => {
    const h = harness();
    const table = revisionGuardedTable([]);
    answerDeleteReads(h.mock, projected(row('r0')));
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).resolves.toBeUndefined();

    expect(table.tokens).toHaveLength(1);
    expect(h.warn).not.toHaveBeenCalled();
    expect(h.released()).toEqual(['users/u1/profile.bin']);
  });
});

describe('deleteStoreItem across the upgrade that introduced revisions', () => {
  it('pins the absence of a revision on a row written before 0.9.0', async () => {
    const h = harness();
    const table = revisionGuardedTable([row(undefined)]);
    answerDeleteReads(h.mock, projected(row(undefined)));
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).resolves.toBeUndefined();

    expect(sentDelete(h.mock)).toMatchObject({
      ConditionExpression: 'attribute_not_exists(#rev)',
      ExpressionAttributeNames: { '#rev': 'rev' },
    });
    expect(table.rows.size).toBe(0);
  });

  it('is turned away by a racer that stamped one, and re-pins onto it', async () => {
    const h = harness();
    const table = revisionGuardedTable([row('stamped', 'theirs.bin')]);
    answerDeleteReads(h.mock, projected(row(undefined)));
    h.mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).resolves.toBeUndefined();

    expect(table.tokens).toHaveLength(2);
    expect(sentDelete(h.mock, 1).ExpressionAttributeValues).toEqual({ ':rev': 'stamped' });
    expect(table.rows.size).toBe(0);
  });
});

describe('deleteStoreItem when the transaction budget is spent', () => {
  it('resolves once the row is confirmed gone, releasing the observed object', async () => {
    const h = harness();
    answerDeleteReads(h.mock, projected(row('r0')), undefined);
    h.mock.on(TransactWriteCommand).rejects(throttled());

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).resolves.toBeUndefined();

    expect(h.released()).toEqual(['users/u1/profile.bin']);
  });

  it('rethrows while the row is still there, releasing nothing', async () => {
    const h = harness();
    answerDeleteReads(h.mock, projected(row('r0')), row('r0'));
    h.mock.on(TransactWriteCommand).rejects(throttled());

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).rejects.toMatchObject({
      code: ErrorCode.RETRY_EXHAUSTED,
    });
    expect(h.released()).toEqual([]);
  });

  it('releases what the re-pin observed, not what the pre-read did, when the budget then dies', () => {
    /**
     * The composition the other two cases leave to construction: a racer wins
     * the first attempt, the call re-pins onto that racer's row, and only then
     * does the budget die with the row confirmed gone. What is released must be
     * the racer's object - the row that was actually removed - and never the
     * one the pre-read saw. Returning the pre-read's observation on this path
     * would delete an object no row ever named again while leaving the racer's
     * behind.
     */
    const h = harness();
    answerDeleteReads(h.mock, projected(row('r0')), undefined);
    let attempt = 0;
    h.mock.on(TransactWriteCommand).callsFake(() => {
      attempt += 1;
      if (attempt === 1) throw rejectedWith(row('stamped', 'theirs.bin'));
      throw throttled();
    });

    return expect(deleteStoreItem(h.ctx, op, PK, SK))
      .resolves.toBeUndefined()
      .then(() => {
        expect(h.released()).toEqual(['theirs.bin']);
      });
  });

  it('propagates a failure that is neither a guard rejection nor a spent budget', async () => {
    const h = harness();
    answerDeleteReads(h.mock, projected(row('r0')));
    h.mock
      .on(TransactWriteCommand)
      .rejects(Object.assign(new Error('bad'), { name: 'ValidationException' }));

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).rejects.toThrow('bad');
    expect(h.released()).toEqual([]);
  });
});

describe('deleteStoreItem now issues a read before anything else', () => {
  it('propagates a pre-read failure with nothing written and nothing released', async () => {
    const h = harness();
    h.mock
      .on(GetCommand)
      .rejects(Object.assign(new Error('read down'), { name: 'ValidationException' }));
    h.mock.on(TransactWriteCommand).resolves({});

    await expect(deleteStoreItem(h.ctx, op, PK, SK)).rejects.toThrow('read down');
    expect(h.mock.commandCalls(TransactWriteCommand)).toHaveLength(0);
    expect(h.released()).toEqual([]);
  });

  it('costs one read and one write, and releases nothing, with no offloader configured', async () => {
    const { client, mock } = createStrictDocumentMock();
    const table = revisionGuardedTable([row('r0')]);
    answerDeleteReads(mock, projected(row('r0')));
    mock.on(TransactWriteCommand).callsFake(table.handler);

    await expect(deleteStoreItem(context(client), op, PK, SK)).resolves.toBeUndefined();

    expect(mock.calls()).toHaveLength(2);
    expect(table.rows.size).toBe(0);
  });
});
