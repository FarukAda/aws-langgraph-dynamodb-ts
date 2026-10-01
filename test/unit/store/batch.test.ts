import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { ErrorCode } from '../../../src/shared/errors/error-code';
import { DynamoDBStore } from '../../../src/store/store';
import {
  answerDeleteReads,
  createStrictDocumentMock,
  deletedKeys,
  observableRow,
  resolveRowDeletes,
} from '../../shared/helpers/ddb-mock';

type Mock = ReturnType<typeof createStrictDocumentMock>['mock'];

/** A GetCommand stub that yields once per call and records the peak number in flight. */
function overlappingGet(mock: Mock): () => number {
  let inFlight = 0;
  let max = 0;
  mock.on(GetCommand).callsFake(async () => {
    inFlight += 1;
    max = Math.max(max, inFlight);
    await new Promise((resolve) => setImmediate(resolve));
    inFlight -= 1;
    return {};
  });
  return () => max;
}

describe('DynamoDBStore.batch dispatches independent operations concurrently', () => {
  it('runs reads concurrently, up to 8 at a time, and keeps results in operation order', async () => {
    const { client, mock } = createStrictDocumentMock();
    const maxInFlight = overlappingGet(mock);
    const store = new DynamoDBStore({ tableName: 'store', client });
    const results = await store.batch(
      Array.from({ length: 10 }, (_, i) => ({ namespace: ['n'], key: `k${i}` })),
    );
    expect(results).toEqual(Array.from({ length: 10 }, () => null));
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(maxInFlight()).toBeLessThanOrEqual(8);
  });

  /** The reference applies only the last put per key; two compare-and-swaps on one item would race for an outcome already decided. */
  it('sends only the last of two puts to one key', async () => {
    const { client, mock } = createStrictDocumentMock();
    const written: string[] = [];
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).callsFake((input) => {
      written.push(new TextDecoder().decode(input.Item.value.bytes as Uint8Array));
      return {};
    });
    const store = new DynamoDBStore({ tableName: 'store', client });
    const results = await store.batch([
      { namespace: ['n'], key: 'k', value: { v: 'first' } },
      { namespace: ['n'], key: 'k', value: { v: 'second' } },
    ]);
    expect(written).toEqual(['{"v":"second"}']);
    expect(results).toEqual([null, null]);
  });

  /**
   * As the reference evaluates a batch: every read answers as the batch found
   * things, and the writes land afterwards. Two tasks of one superstep touching
   * one item therefore get the same answers whichever was enqueued first.
   */
  it('answers a get before the put to the same key in the batch lands', async () => {
    const { client, mock } = createStrictDocumentMock();
    let stored: Record<string, unknown> | undefined;
    mock.on(GetCommand).callsFake((input) => (input.ProjectionExpression ? {} : { Item: stored }));
    mock.on(PutCommand).callsFake((input) => {
      stored = input.Item;
      return {};
    });
    const store = new DynamoDBStore({ tableName: 'store', client });
    const [, item] = await store.batch([
      { namespace: ['n'], key: 'k', value: { v: 1 } },
      { namespace: ['n'], key: 'k' },
    ]);
    expect(item).toBeNull();
    expect(stored).toBeDefined();
  });

  /** A put and a delete answer `null`, as the reference store's `batch` does. */
  it('returns a mixed batch in operation order', async () => {
    const { client, mock } = createStrictDocumentMock();
    /** The projected pre-read observes a row, so the delete operation is really sent. */
    answerDeleteReads(mock, observableRow());
    mock.on(PutCommand).resolves({});
    resolveRowDeletes(mock);
    mock.on(QueryCommand).resolves({ Items: [] });
    mock
      .on(ScanCommand)
      .resolves({ Items: [{ PK: 'STORE#a', SK: 'k', namespace: ['a'], key: 'k' }] });
    const store = new DynamoDBStore({ tableName: 'store', client });
    const results = await store.batch([
      { namespace: ['n'], key: 'k' },
      { namespacePrefix: ['n'] },
      { namespace: ['n'], key: 'k', value: { v: 1 } },
      { namespace: ['n'], key: 'gone', value: null },
      { matchConditions: [], maxDepth: undefined, limit: 10, offset: 0 },
    ]);
    expect(results).toStrictEqual([null, [], null, null, [['a']]]);
    expect(deletedKeys(mock)).toEqual([{ PK: 'STORE#n', SK: 'gone' }]);
  });

  it('rejects the whole batch when one operation fails', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const store = new DynamoDBStore({ tableName: 'store', client });
    await expect(
      store.batch([
        { namespace: ['n'], key: 'ok' },
        { namespace: ['n'], key: '' },
      ]),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION });
  });
});
