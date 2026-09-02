import { GetCommand, PutCommand, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { ErrorCode } from '../../../src/shared/errors/error-code';
import { DynamoDBStore } from '../../../src/store/store';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

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

const yieldTimes = async (ticks: number): Promise<void> => {
  for (let i = 0; i < ticks; i++) await new Promise((resolve) => setImmediate(resolve));
};

describe('DynamoDBStore.batch dispatches independent operations concurrently (STORE-06)', () => {
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

  it('keeps two puts to one key ordered so the later one wins, even when the first is slower', async () => {
    const { client, mock } = createStrictDocumentMock();
    const written: string[] = [];
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).callsFake(async (input) => {
      const value = new TextDecoder().decode(input.Item.value.bytes as Uint8Array);
      await yieldTimes(value.includes('first') ? 3 : 0);
      written.push(value);
      return {};
    });
    const store = new DynamoDBStore({ tableName: 'store', client });
    await store.batch([
      { namespace: ['n'], key: 'k', value: { v: 'first' } },
      { namespace: ['n'], key: 'k', value: { v: 'second' } },
    ]);
    expect(written).toEqual(['{"v":"first"}', '{"v":"second"}']);
  });

  it('lets a get after a put to the same key observe the put', async () => {
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
    expect(item?.value).toEqual({ v: 1 });
  });

  it('returns a mixed batch in operation order', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    mock.on(QueryCommand).resolves({ Items: [] });
    mock
      .on(ScanCommand)
      .resolves({ Items: [{ PK: 'STORE#a', SK: 'k', namespace: ['a'], key: 'k' }] });
    const store = new DynamoDBStore({ tableName: 'store', client });
    const results = await store.batch([
      { namespace: ['n'], key: 'k' },
      { namespacePrefix: ['n'] },
      { namespace: ['n'], key: 'k', value: { v: 1 } },
      { matchConditions: [], maxDepth: undefined, limit: 10, offset: 0 },
    ]);
    expect(results).toEqual([null, [], undefined, [['a']]]);
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
