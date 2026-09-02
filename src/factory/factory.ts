import type { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

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
  /**
   * Reused as-is by every adapter. Construct it with `maxAttempts: 1`, or the
   * SDK's own retries stack inside the library's retry budget (each adapter
   * logs a `warn` at construction when they would).
   */
  client?: DynamoDBDocument;
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

function overridesClient(options: FactoryBaseOptions): boolean {
  return (
    options.client !== undefined ||
    options.clientConfig !== undefined ||
    options.createClient !== undefined
  );
}

/**
 * Convenience constructors for the adapters. Individual `create*` methods each
 * build their own client; {@link createAll} builds one shared client used by all
 * three and returns a combined `destroy` that tears everything down once.
 */
export class DynamoDBFactory {
  constructor(private readonly base: FactoryBaseOptions = {}) {}

  /**
   * Per-adapter options replace the factory's client choice as a unit: a
   * `client` handed to `createSaver` also displaces the base `clientConfig`
   * and `createClient`, because carrying those along is exactly the ambiguous
   * combination the adapters' option validation rejects.
   */
  private defaultsFor(options: FactoryBaseOptions): FactoryBaseOptions {
    return overridesClient(options) ? { logger: this.base.logger } : this.base;
  }

  createSaver(options: DynamoDBSaverOptions): DynamoDBSaver {
    return new DynamoDBSaver({ ...this.defaultsFor(options), ...options });
  }

  createStore(options: DynamoDBStoreOptions): DynamoDBStore {
    return new DynamoDBStore({ ...this.defaultsFor(options), ...options });
  }

  createChatMessageHistory(options: DynamoDBChatMessageHistoryOptions): DynamoDBChatMessageHistory {
    return new DynamoDBChatMessageHistory({ ...this.defaultsFor(options), ...options });
  }

  createAll(options: CreateAllOptions): CreatedAdapters {
    const resolved = resolveDynamoDBClient(this.base);
    const client = resolved.client;
    const shared = this.defaultsFor({ client });
    const saver = new DynamoDBSaver({ ...shared, ...options.saver, client });
    const store = new DynamoDBStore({ ...shared, ...options.store, client });
    const history = new DynamoDBChatMessageHistory({ ...shared, ...options.history, client });
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
