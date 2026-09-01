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
    expect(factory.createSaver({ tableName: 'ckpt', client })).toBeInstanceOf(DynamoDBSaver);
    expect(factory.createStore({ tableName: 'store', client })).toBeInstanceOf(DynamoDBStore);
    expect(factory.createChatMessageHistory({ tableName: 'hist', client })).toBeInstanceOf(
      DynamoDBChatMessageHistory,
    );
  });

  it('individual create* calls fall back to the factory client defaults', () => {
    const fake = fakeClientFactory();
    const factory = new DynamoDBFactory({
      clientConfig: { region: 'eu-west-1' },
      createClient: fake.create,
    });
    const saver = factory.createSaver({ tableName: 'ckpt' });
    saver.destroy();
    expect(fake.destroy).toHaveBeenCalledTimes(1);
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
    const destroySpy = jest.spyOn(client, 'destroy');
    const factory = new DynamoDBFactory({ client });
    const all = factory.createAll({
      saver: { tableName: 'ckpt' },
      store: { tableName: 'store' },
      history: { tableName: 'hist' },
    });
    expect(all.saver).toBeInstanceOf(DynamoDBSaver);
    all.destroy();
    // The factory doesn't own an injected client, so tearing every adapter
    // down must never destroy the caller's own client out from under them.
    expect(destroySpy).not.toHaveBeenCalled();
  });

  it('createAll builds a default client when no factory base options are given', () => {
    const factory = new DynamoDBFactory();
    const all = factory.createAll({
      saver: { tableName: 'ckpt' },
      store: { tableName: 'store' },
      history: { tableName: 'hist' },
    });
    expect(all.saver).toBeInstanceOf(DynamoDBSaver);
    expect(() => all.destroy()).not.toThrow();
  });

  it('createAll passes maxAttempts: 1 through to the client factory (disables SDK-internal retries)', () => {
    const fake = fakeClientFactory();
    const createClient = jest.fn(fake.create);
    const factory = new DynamoDBFactory({ clientConfig: { region: 'eu-west-1' }, createClient });
    factory.createAll({
      saver: { tableName: 'ckpt' },
      store: { tableName: 'store' },
      history: { tableName: 'hist' },
    });
    expect(createClient).toHaveBeenCalledWith({ maxAttempts: 1, region: 'eu-west-1' });
  });
});
