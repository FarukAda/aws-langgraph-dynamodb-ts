import { DynamoDBSaver } from '../checkpointer/saver';
import type { DynamoDBSaverOptions } from '../checkpointer/types';
import { DynamoDBChatMessageHistory } from '../history/chat-message-history';
import type { DynamoDBChatMessageHistoryOptions } from '../history/types';
import { s3ClientOptions } from '../shared/codec/s3/client-types';
import type { S3OffloadConfig } from '../shared/codec/s3/config';
import { resolveDynamoDBClient } from '../shared/dynamodb/client';
import { type Logger, resolveLogger } from '../shared/logging/logger';
import { allKeysOf, assertShape } from '../shared/validation/option-shape';
import { validateClientChoice } from '../shared/validation/options';
import { DynamoDBStore } from '../store/store';
import type { DynamoDBStoreOptions } from '../store/types';
import type { CreateAllOptions, CreatedAdapters, FactoryBaseOptions } from './types';

/** The factory's own options, checked against {@link FactoryBaseOptions} at compile time. */
const FACTORY_BASE_KEYS = allKeysOf<FactoryBaseOptions>({
  client: 'client',
  clientConfig: 'clientConfig',
  createClient: 'createClient',
  logger: 'logger',
  ttl: 'ttl',
  compression: 'compression',
  s3: 's3',
  retry: 'retry',
});

/** The sections `createAll` builds, checked against {@link CreateAllOptions} at compile time. */
const CREATE_ALL_KEYS = allKeysOf<CreateAllOptions>({
  saver: 'saver',
  store: 'store',
  history: 'history',
});

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

/**
 * Release one resource without letting its failure strand the others.
 *
 * Teardown runs in two places that must both finish: the caller's `destroy`,
 * where a throw halfway through would leak every resource after it, and the
 * rollback of a failed {@link DynamoDBFactory.createAll}, where it would also
 * replace the constructor error the caller needs with its own.
 */
function release(logger: Logger, close: () => void): void {
  try {
    close();
  } catch (error) {
    logger.warn('factory.destroy: an adapter did not release its resources', {
      reason: (error as Error).name,
    });
  }
}

function overridesClient(options: FactoryBaseOptions): boolean {
  return (
    options.client !== undefined ||
    options.clientConfig !== undefined ||
    options.createClient !== undefined
  );
}

/**
 * Convenience constructors for the adapters.
 *
 * Individual `create*` methods each build their own client; {@link createAll}
 * builds one shared client used by all three and returns a combined `destroy`
 * that tears everything down once. The factory validates nothing itself: each
 * adapter validates the options it ends up with, so the same mistake is caught
 * the same way however the adapter was built.
 */
export class DynamoDBFactory {
  /**
   * Accepts: `base` — the defaults every adapter inherits. Checked here, where
   * the caller wrote them: an unknown key would otherwise be ignored, and a
   * `client` next to a `clientConfig` was refused by the first `create*` call
   * and accepted by `createAll`, for the same base.
   *
   * Returns: a factory holding those defaults. It opens nothing: every client
   * is built by the `create*` call that needs one.
   *
   * Throws: ValidationError naming the offending option. Everything else each
   * adapter validates for itself, since a per-adapter value may still replace
   * it.
   */
  constructor(private readonly base: FactoryBaseOptions = {}) {
    assertShape(base, FACTORY_BASE_KEYS, 'options');
    validateClientChoice(base);
  }

  /** The base options every adapter inherits regardless of which client it uses. */
  private sharedDefaults(): SharedDefaults {
    const { logger, ttl, compression, s3, retry } = this.base;
    return { logger, ttl, compression, s3, retry };
  }

  /**
   * The base `s3` config with the region the DynamoDB side was configured with
   * already filled in.
   *
   * An adapter normally reads that region off its own `clientConfig`
   * (`offloaderConfigFor`), but the adapters {@link createAll} builds are given
   * the one shared `client` instead — and a `clientConfig` beside a `client` is
   * refused, because for the DynamoDB client it would be silently ignored. So
   * the region has to be carried here, on the config that still needs it. A
   * bucket reachable only through that region otherwise failed with an opaque
   * `PermanentRedirect` on the first offload, while the identical configuration
   * through `createStore` worked.
   */
  private sharedS3(): S3OffloadConfig | undefined {
    const s3 = this.base.s3;
    if (s3 === undefined) return undefined;
    const region = s3ClientOptions(s3.clientConfig).region ?? this.base.clientConfig?.region;
    if (region === undefined) return s3;
    return { ...s3, clientConfig: { ...s3.clientConfig, region } };
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

  /**
   * A saver on its own client.
   *
   * Accepts: `options` — the saver's own, laid over the factory's defaults. A
   * per-adapter value wins; see {@link defaultsFor} for how a client choice
   * replaces the factory's as a unit.
   *
   * Returns: the saver, which owns the client it built and releases it on
   * `destroy()`.
   *
   * Throws: ValidationError for any invalid option, naming it.
   */
  createSaver(options: DynamoDBSaverOptions): DynamoDBSaver {
    return new DynamoDBSaver({ ...this.defaultsFor(options), ...options });
  }

  /**
   * A store on its own client.
   *
   * Accepts: as {@link createSaver}, for the store's options.
   *
   * Returns: the store.
   *
   * Throws: as {@link createSaver}.
   */
  createStore(options: DynamoDBStoreOptions): DynamoDBStore {
    return new DynamoDBStore({ ...this.defaultsFor(options), ...options });
  }

  /**
   * A chat history on its own client.
   *
   * Accepts: as {@link createSaver}, for the history's options.
   *
   * Returns: the chat history.
   *
   * Throws: as {@link createSaver}.
   */
  createChatMessageHistory(options: DynamoDBChatMessageHistoryOptions): DynamoDBChatMessageHistory {
    return new DynamoDBChatMessageHistory({ ...this.defaultsFor(options), ...options });
  }

  /**
   * Build the adapters whose sections are given, all on one shared client.
   *
   * Accepts: `options` — a section per adapter, laid over the factory's shared
   * defaults; omitting one skips that adapter, and `{}` builds none. A key that
   * is not a section name is refused rather than ignored: a misspelt one
   * silently built nothing and handed back three `undefined`s.
   *
   * Returns: the adapters, typed by the sections asked for, and one `destroy`
   * that releases all of them and the shared client. A client the factory was
   * given rather than built is never destroyed.
   *
   * Throws: ValidationError naming the offending option or section key.
   * Whatever an adapter's constructor throws — after the adapters already
   * built and the freshly created client have been released, so a failed call
   * leaks nothing and the constructor's own error is the one that propagates.
   *
   * Guarantees: one DynamoDB client for all three adapters, and one S3 client
   * per adapter, each under its own key prefix in the shared bucket. Teardown
   * is total: one adapter failing to release its resources cannot strand the
   * others.
   */
  createAll<O extends CreateAllOptions>(options: O): CreatedAdapters<O> {
    assertShape(options, CREATE_ALL_KEYS, 'options');
    const logger = resolveLogger(this.base.logger);
    const resolved = resolveDynamoDBClient(this.base);
    const shared = { ...this.sharedDefaults(), s3: this.sharedS3(), client: resolved.client };
    const built: Destroyable[] = [];
    /** Record an adapter the moment it exists, so a later failure can still tear it down. */
    const track = <T extends Destroyable>(adapter: T): T => {
      built.push(adapter);
      return adapter;
    };
    const destroy = (): void => {
      for (const adapter of built) release(logger, () => adapter.destroy());
      release(logger, () => resolved.ddbClient?.destroy());
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
