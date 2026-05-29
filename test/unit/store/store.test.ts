import { DeleteCommand, GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';

import { DynamoDBStore } from '../../../src/store/store';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

describe('DynamoDBStore', () => {
  it('put then get round-trips an item (dispatch: put + get)', async () => {
    const { client, mock } = createStrictDocumentMock();
    let stored;
    mock.on(GetCommand).callsFake((input) => (input.ProjectionExpression ? {} : { Item: stored }));
    mock.on(PutCommand).callsFake((input) => {
      stored = input.Item;
      return {};
    });
    const store = new DynamoDBStore({ tableName: 'store', client });
    await store.put(['users', 'u1'], 'profile', { name: 'Faruk' });
    const item = await store.get(['users', 'u1'], 'profile');
    expect(item?.value).toEqual({ name: 'Faruk' });
  });

  it('delete dispatches a DeleteCommand', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(DeleteCommand).resolves({});
    const store = new DynamoDBStore({ tableName: 'store', client });
    await store.delete(['n'], 'k');
    expect(mock.commandCalls(DeleteCommand)).toHaveLength(1);
  });

  it('search dispatches a Scan and returns matches', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [] });
    const store = new DynamoDBStore({ tableName: 'store', client });
    expect(await store.search(['users'])).toEqual([]);
    expect(mock.commandCalls(ScanCommand)).toHaveLength(1);
  });

  it('listNamespaces dispatches a Scan', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(ScanCommand).resolves({ Items: [{ namespace: ['a'] }] });
    const store = new DynamoDBStore({ tableName: 'store', client });
    expect(await store.listNamespaces()).toEqual([['a']]);
  });

  it('executes a mixed batch in order', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(ScanCommand).resolves({ Items: [] });
    const store = new DynamoDBStore({ tableName: 'store', client });
    const results = await store.batch([{ namespace: ['n'], key: 'k' }, { namespacePrefix: ['n'] }]);
    expect(results).toEqual([null, []]);
  });

  it('does not destroy an injected client but does destroy an owned one', () => {
    const injected = createStrictDocumentMock();
    expect(() =>
      new DynamoDBStore({ tableName: 'store', client: injected.client }).destroy(),
    ).not.toThrow();

    const destroy = jest.fn();
    const fake = { destroy, config: {}, middlewareStack: { clone: () => ({}) }, send: jest.fn() };
    const owned = new DynamoDBStore({
      tableName: 'store',
      clientConfig: { region: 'us-east-1' },
      createClient: () => fake as never,
    });
    owned.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});
