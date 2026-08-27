import { DynamoDBSaver } from '../../../src/checkpointer/saver';
import { DynamoDBFactory } from '../../../src/factory/factory';
import { DynamoDBChatMessageHistory } from '../../../src/history/chat-message-history';
import { DynamoDBStore } from '../../../src/store/store';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';

function fakeClientFactory() {
  const destroy = jest.fn();
  const client = { destroy, config: {}, middlewareStack: { clone: () => ({}) }, send: jest.fn() };
  return { destroy, create: () => client as never };
}

describe('DynamoDBFactory', () => {
  it('builds each adapter individually', () => {
    const factory = new DynamoDBFactory({ clientConfig: { region: 'eu-west-1' } });
    const { client } = createStrictDocumentMock();
    expect(factory.createSaver({ tableName: 'c', client })).toBeInstanceOf(DynamoDBSaver);
    expect(factory.createStore({ tableName: 's', client })).toBeInstanceOf(DynamoDBStore);
    expect(factory.createChatMessageHistory({ tableName: 'h', client })).toBeInstanceOf(
      DynamoDBChatMessageHistory,
    );
  });

  it('createAll shares one client and destroys it exactly once', () => {
    const fake = fakeClientFactory();
    const factory = new DynamoDBFactory({
      clientConfig: { region: 'eu-west-1' },
      createClient: fake.create,
    });
    const all = factory.createAll({
      saver: { tableName: 'checkpoints' },
      store: { tableName: 'store' },
      history: { tableName: 'history' },
    });
    expect(all.saver).toBeInstanceOf(DynamoDBSaver);
    expect(all.store).toBeInstanceOf(DynamoDBStore);
    expect(all.history).toBeInstanceOf(DynamoDBChatMessageHistory);
    all.destroy();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
  });

  it('createAll reuses an injected base client instead of building a new one', () => {
    const { client } = createStrictDocumentMock();
    const factory = new DynamoDBFactory({ client });
    const all = factory.createAll({
      saver: { tableName: 'c' },
      store: { tableName: 's' },
      history: { tableName: 'h' },
    });
    expect(all.saver).toBeInstanceOf(DynamoDBSaver);
    // No owned ddbClient was created, so destroy() must not throw even though
    // there's nothing of its own to tear down.
    expect(() => all.destroy()).not.toThrow();
  });

  it('createAll builds a default client when no factory base options are given', () => {
    const factory = new DynamoDBFactory();
    const all = factory.createAll({
      saver: { tableName: 'c' },
      store: { tableName: 's' },
      history: { tableName: 'h' },
    });
    expect(all.saver).toBeInstanceOf(DynamoDBSaver);
    expect(() => all.destroy()).not.toThrow();
  });

  it('createAll passes maxAttempts: 1 through to the client factory (disables SDK-internal retries)', () => {
    const fake = fakeClientFactory();
    const createClient = jest.fn(fake.create);
    const factory = new DynamoDBFactory({ clientConfig: { region: 'eu-west-1' }, createClient });
    factory.createAll({
      saver: { tableName: 'c' },
      store: { tableName: 's' },
      history: { tableName: 'h' },
    });
    expect(createClient).toHaveBeenCalledWith({ maxAttempts: 1, region: 'eu-west-1' });
  });
});
