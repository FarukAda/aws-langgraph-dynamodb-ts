import type { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';

import { DynamoDBSaver } from '../checkpointer/saver';
import type { DynamoDBSaverOptions } from '../checkpointer/types';
import { DynamoDBChatMessageHistory } from '../history/chat-message-history';
import type { DynamoDBChatMessageHistoryOptions } from '../history/types';
import { resolveDynamoDBClient } from '../shared/dynamodb/client';
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
  saver: Omit<DynamoDBSaverOptions, 'client' | 'clientConfig' | 'createClient'>;
  store: Omit<DynamoDBStoreOptions, 'client' | 'clientConfig' | 'createClient'>;
  history: Omit<DynamoDBChatMessageHistoryOptions, 'client' | 'clientConfig' | 'createClient'>;
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
    const resolved = resolveDynamoDBClient(this.base);
    const client = resolved.client;
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
        resolved.ddbClient?.destroy();
      },
    };
  }
}
