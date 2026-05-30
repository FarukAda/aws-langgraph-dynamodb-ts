import { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import { DynamoDBStore } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from '../integration/helpers/ddb-local';

const tableName = 'store-contract';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let store: DynamoDBStore;

beforeAll(async () => {
  await createTable(admin, tableName);
  store = new DynamoDBStore({ tableName, clientConfig: DDB_LOCAL_CONFIG });
});

afterAll(async () => {
  store.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('BaseStore contract conformance', () => {
  it('batch returns OperationResults in the documented shapes, in order', async () => {
    const [putResult, getResult, searchResult, namespacesResult] = await store.batch([
      { namespace: ['c', 'u1'], key: 'k', value: { v: 1 } },
      { namespace: ['c', 'u1'], key: 'k' },
      { namespacePrefix: ['c', 'u1'] },
      { matchConditions: [{ matchType: 'prefix', path: ['c'] }], limit: 10, offset: 0 },
    ]);

    expect(putResult).toBeUndefined();
    expect(getResult).toMatchObject({ namespace: ['c', 'u1'], key: 'k', value: { v: 1 } });
    expect(Array.isArray(searchResult)).toBe(true);
    expect((searchResult as { key: string }[]).map((item) => item.key)).toEqual(['k']);
    expect(namespacesResult).toEqual([['c', 'u1']]);
  });

  it('put with a null value deletes the item', async () => {
    await store.put(['c', 'u2'], 'k', { v: 2 });
    expect(await store.get(['c', 'u2'], 'k')).not.toBeNull();
    await store.put(['c', 'u2'], 'k', null);
    expect(await store.get(['c', 'u2'], 'k')).toBeNull();
  });
});
