import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { DynamoDBSaver } from '../checkpointer/saver';
import type { DynamoDBSaverOptions } from '../checkpointer/types';
import { DynamoDBChatMessageHistory } from '../history/chat-message-history';
import type { DynamoDBChatMessageHistoryOptions } from '../history/types';
import type { Logger } from '../shared/logging/logger';
import { DynamoDBStore } from '../store/store';
import type { DynamoDBStoreOptions } from '../store/types';

/** Shared client/logger defaults applied to every adapter the factory builds. */
export interface FactoryBaseOptions {
  clientConfig?: DynamoDBClientConfig;
  createClient?: (config: DynamoDBClientConfig) => DynamoDBClient;
  logger?: Logger;
}

/** Per-adapter options for {@link DynamoDBFactory.createAll} (client is shared). */
export interface CreateAllOptions {
  saver: Omit<DynamoDBSaverOptions, 'client'>;
  store: Omit<DynamoDBStoreOptions, 'client'>;
  history: Omit<DynamoDBChatMessageHistoryOptions, 'client'>;
}

/** The three adapters sharing one client, plus a combined `destroy`. */
export interface CreatedAdapters {
  saver: DynamoDBSaver;
  store: DynamoDBStore;
  history: DynamoDBChatMessageHistory;
  destroy: () => void;
}

/**
 * Convenience constructors for the adapters. Individual `create*` methods each
 * build their own client; {@link createAll} builds one shared client used by all
 * three and returns a combined `destroy` that tears everything down once.
 */
export class DynamoDBFactory {
  constructor(private readonly base: FactoryBaseOptions = {}) {}

  createSaver(options: DynamoDBSaverOptions): DynamoDBSaver {
    return new DynamoDBSaver({ ...this.base, ...options });
  }

  createStore(options: DynamoDBStoreOptions): DynamoDBStore {
    return new DynamoDBStore({ ...this.base, ...options });
  }

  createChatMessageHistory(options: DynamoDBChatMessageHistoryOptions): DynamoDBChatMessageHistory {
    return new DynamoDBChatMessageHistory({ ...this.base, ...options });
  }

  createAll(options: CreateAllOptions): CreatedAdapters {
    const build = this.base.createClient ?? ((config) => new DynamoDBClient(config));
    const ddbClient = build(this.base.clientConfig ?? {});
    const client = DynamoDBDocument.from(ddbClient);
    const saver = new DynamoDBSaver({ ...this.base, ...options.saver, client });
    const store = new DynamoDBStore({ ...this.base, ...options.store, client });
    const history = new DynamoDBChatMessageHistory({ ...this.base, ...options.history, client });
    return {
      saver,
      store,
      history,
      destroy: () => {
        saver.destroy();
        store.destroy();
        history.destroy();
        ddbClient.destroy();
      },
    };
  }
}
