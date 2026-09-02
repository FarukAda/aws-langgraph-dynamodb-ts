import { DynamoDBSaver } from '../checkpointer/saver';
import type { DynamoDBSaverOptions } from '../checkpointer/types';
import { DynamoDBChatMessageHistory } from '../history/chat-message-history';
import type { DynamoDBChatMessageHistoryOptions } from '../history/types';
import { resolveDynamoDBClient } from '../shared/dynamodb/client';
import { DynamoDBStore } from '../store/store';
import type { DynamoDBStoreOptions } from '../store/types';
import type { CreateAllOptions, CreatedAdapters, FactoryBaseOptions } from './types';

/** What every adapter offers the factory for teardown. */
interface Destroyable {
  destroy(): void;
}

/** The base options that carry over to an adapter whatever client it ends up with. */
type SharedDefaults = Pick<FactoryBaseOptions, 'logger' | 'ttl' | 'compression' | 's3' | 'retry'>;

/** The adapters a `createAll` call produced, before the result is typed by its sections. */
interface BuiltAdapters {
  saver: DynamoDBSaver | undefined;
  store: DynamoDBStore | undefined;
  history: DynamoDBChatMessageHistory | undefined;
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

  /** The base options every adapter inherits regardless of which client it uses. */
  private sharedDefaults(): SharedDefaults {
    const { logger, ttl, compression, s3, retry } = this.base;
    return { logger, ttl, compression, s3, retry };
  }

  /**
   * Per-adapter options replace the factory's client choice as a unit: a
   * `client` handed to `createSaver` also displaces the base `clientConfig`
   * and `createClient`, because carrying those along is exactly the ambiguous
   * combination the adapters' option validation rejects. The shared
   * `ttl`/`compression`/`s3`/`retry` defaults stay either way.
   */
  private defaultsFor(options: FactoryBaseOptions): FactoryBaseOptions {
    return overridesClient(options) ? this.sharedDefaults() : this.base;
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

  /**
   * Build the adapters whose sections are given, all on one shared client and
   * with the factory's shared defaults underneath each section. If any
   * constructor throws (a store with `vectorBackend` but no `index`, say), the
   * adapters already built and the freshly created client are destroyed
   * before the error propagates, so a failed call leaks nothing.
   */
  createAll<O extends CreateAllOptions>(options: O): CreatedAdapters<O> {
    const resolved = resolveDynamoDBClient(this.base);
    const shared = { ...this.sharedDefaults(), client: resolved.client };
    const built: Destroyable[] = [];
    /** Record an adapter the moment it exists, so a later failure can still tear it down. */
    const track = <T extends Destroyable>(adapter: T): T => {
      built.push(adapter);
      return adapter;
    };
    const destroy = (): void => {
      for (const adapter of built) adapter.destroy();
      resolved.ddbClient?.destroy();
    };
    const { saver, store, history } = options;
    try {
      const adapters: BuiltAdapters = {
        saver: saver && track(new DynamoDBSaver({ ...shared, ...saver })),
        store: store && track(new DynamoDBStore({ ...shared, ...store })),
        history: history && track(new DynamoDBChatMessageHistory({ ...shared, ...history })),
        destroy,
      };
      return adapters as CreatedAdapters<O>;
    } catch (error) {
      destroy();
      throw error;
    }
  }
}
