/**
 * Hides how several adapters share one client and one set of defaults.
 *
 * A caller states its defaults once; which adapter gets the base client
 * choice and which its own, how the DynamoDB region reaches a shared `s3`
 * config, and who destroys a client the factory built rather than was handed
 * are decided here. Teardown is total — one adapter failing to release cannot
 * strand the others — and a `createAll` that fails partway releases what it
 * had built before its own error propagates.
 */

import { DynamoDBSaver } from '../checkpointer/saver.js';
import type { DynamoDBSaverOptions } from '../checkpointer/types.js';
import { DynamoDBChatMessageHistory } from '../history/chat-message-history.js';
import type { DynamoDBChatMessageHistoryOptions } from '../history/types.js';
import { s3ClientOptions } from '../shared/codec/s3/client-types.js';
import type { S3OffloadConfig } from '../shared/codec/s3/config.js';
import { resolveDynamoDBClient } from '../shared/dynamodb/client.js';
import { failureLabel } from '../shared/errors/base-error.js';
import { type Logger, resolveLogger } from '../shared/logging/logger.js';
import { truncateForLog } from '../shared/logging/truncate.js';
import { assertMembers, LOGGER_MEMBERS } from '../shared/validation/collaborators.js';
import {
  allKeysOf,
  assertObjectShape,
  assertShape,
  isObjectShape,
} from '../shared/validation/option-shape.js';
import { assertClientChoice } from '../shared/validation/options.js';
import { DynamoDBStore } from '../store/store.js';
import type { DynamoDBStoreOptions } from '../store/types.js';
import type { CreateAllOptions, CreatedAdapters, FactoryBaseOptions } from './types.js';

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
    // The name, never the message — and bounded, because a name is a string an
    // adapter's own `close` threw and nothing this package ran checked its
    // length. `message` is bounded at `redactedMessage`, and relaying the two
    // halves of "what the failure was" under different rules is the split that
    // rule exists to remove.
    logger.warn('factory.destroy: an adapter did not release its resources', {
      reason: truncateForLog(failureLabel(error as Error)),
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
 * `options` without the keys whose value is `undefined`. A key given that way
 * is "not configured", as it is everywhere in this package, and the factory
 * lays the per-adapter options over its defaults with a spread, where such a
 * key would instead take the default away: a `client: undefined` would replace
 * the shared client with one the adapter builds from nothing, a
 * `ttl: undefined` would drop the factory's expiry without a word.
 */
function given<O extends object>(options: O): O {
  const kept: Record<string, object | undefined> = {};
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) kept[key] = value as object;
  }
  return kept as O;
}

/**
 * Convenience constructors for the adapters.
 *
 * Individual `create*` methods each build one adapter, on the factory's `client`
 * when it was given one and otherwise on a client of their own; {@link createAll}
 * builds one shared client used by all three and returns a combined `destroy`
 * that tears everything down once. Each adapter validates the options it ends
 * up with, so the same mistake is caught the same way however the adapter was
 * built. The factory checks only what it reads itself before an adapter can:
 * its own base options, client choice and logger, the keys of `createAll`'s
 * argument, and that each adapter's options are an object at all.
 *
 * Every `create*` argument and every `createAll` section is one adapter's
 * options, and a mistake in one is named the way that adapter's constructor
 * names it: `options` for a value that is not an object, and the adapter's own
 * field names (`options.<key>`, `tableName`, …) for anything inside one.
 */
export class DynamoDBFactory {
  /**
   * Accepts: `base` — the defaults every adapter inherits. Checked here, where
   * the caller wrote them: an unknown key would otherwise be ignored, and a
   * `client` next to a `clientConfig` was refused by the first `create*` call
   * and accepted by `createAll`, for the same base. So is the shape of
   * `clientConfig`: `createAll` hands its adapters the client built from it,
   * never the config, so no adapter would see a malformed one. And so is
   * `logger`, which `createAll` logs its own teardown failures through: a
   * malformed one threw from inside that teardown, replacing a failed build's
   * own error with a bare `TypeError`.
   *
   * Returns: a factory holding those defaults. It opens nothing: every client
   * is built by the `create*` call that needs one.
   *
   * Throws: `VALIDATION` naming `options.<key>`, `client`, `clientConfig`,
   * `logger` or `logger.<method>`. Everything else each adapter validates for
   * itself, since a per-adapter value may still replace it.
   */
  constructor(private readonly base: FactoryBaseOptions = {}) {
    assertShape(base, FACTORY_BASE_KEYS, 'options');
    assertClientChoice(base);
    if (base.logger !== undefined) assertMembers(base.logger, LOGGER_MEMBERS, 'logger');
  }

  /** The base options every adapter inherits regardless of which client it uses. */
  private sharedDefaults(): SharedDefaults {
    const { logger, ttl, compression, s3, retry } = this.base;
    return { logger, ttl, compression, s3, retry };
  }

  /**
   * An `s3` config with the region the DynamoDB side was configured with
   * filled in, when it names none of its own.
   *
   * An adapter normally reads that region off its own `clientConfig`
   * (`offloaderConfigFor`), but the adapters {@link createAll} builds are given
   * the one shared `client` instead — and a `clientConfig` beside a `client` is
   * refused, because for the DynamoDB client it would be silently ignored. So
   * the region has to be carried here, on the config that still needs it:
   * without it, a bucket reachable only through that region fails with an
   * opaque `PermanentRedirect` on the first offload, unlike the identical
   * configuration through `createStore`, which resolves its own region
   * directly. It is asked of the `s3` an adapter ends up with — the base one,
   * or a section's own, which replaces the base one whole — so neither is left
   * without the region the other would have had.
   *
   * An `s3`, or its `clientConfig`, that is not an object is handed on
   * unchanged, for each adapter to refuse by its own name: reading `.region`
   * off a `null` one would throw here instead, and writing a region into a
   * malformed `clientConfig` would turn it into an object shape an adapter
   * then accepts instead of refusing.
   */
  private withTableRegion(s3: S3OffloadConfig | undefined): S3OffloadConfig | undefined {
    if (!isObjectShape(s3)) return s3;
    if (s3.clientConfig !== undefined && !isObjectShape(s3.clientConfig)) return s3;
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
   * A saver, on the factory's `client` when it has one and otherwise on its own.
   *
   * Accepts: `options` — the saver's own, laid over the factory's defaults. A
   * per-adapter value wins, and a key given as `undefined` is not a value;
   * a client choice (`client`, `clientConfig` or neither) replaces the
   * factory's as a unit.
   *
   * Returns: the saver. It owns, and releases on `destroy()`, only a client it
   * built itself; a `client` from the factory is never closed by it.
   *
   * Throws: `VALIDATION` for any invalid option, naming it as the saver's
   * constructor does — `options` for a value that is not an object, checked
   * before the defaults are laid under it: reading `.client` off a `null`
   * value would throw here, and spreading a string would iterate its
   * characters instead of refusing it.
   */
  createSaver(options: DynamoDBSaverOptions): DynamoDBSaver {
    assertObjectShape(options, 'options');
    const own = given(options);
    return new DynamoDBSaver({ ...this.defaultsFor(own), ...own });
  }

  /**
   * A store, on the factory's `client` when it has one and otherwise on its own.
   *
   * Accepts: as {@link createSaver}, for the store's options.
   *
   * Returns: the store.
   *
   * Throws: as {@link createSaver}.
   */
  createStore(options: DynamoDBStoreOptions): DynamoDBStore {
    assertObjectShape(options, 'options');
    const own = given(options);
    return new DynamoDBStore({ ...this.defaultsFor(own), ...own });
  }

  /**
   * A chat history, on the factory's `client` when it has one and otherwise on
   * its own.
   *
   * Accepts: as {@link createSaver}, for the history's options.
   *
   * Returns: the chat history.
   *
   * Throws: as {@link createSaver}.
   */
  createChatMessageHistory(options: DynamoDBChatMessageHistoryOptions): DynamoDBChatMessageHistory {
    assertObjectShape(options, 'options');
    const own = given(options);
    return new DynamoDBChatMessageHistory({ ...this.defaultsFor(own), ...own });
  }

  /**
   * Build the adapters whose sections are given, all on one shared client.
   *
   * Accepts: `options` — a section per adapter, laid over the factory's shared
   * defaults; omitting one, or giving it as `undefined`, skips that adapter,
   * and `{}` builds none. A key that is not a section name is refused rather
   * than ignored, so a misspelt one cannot silently build nothing. Each section
   * is that adapter's options, so one that is not an object, `null` included,
   * is refused before any client is built.
   *
   * Returns: the adapters, typed by the sections asked for, and one `destroy`
   * that releases all of them and the shared client. A client the factory was
   * given rather than built is never destroyed.
   *
   * Throws: `VALIDATION` naming `options` for an argument or a section that
   * is not an object, or `options.<key>` for a key that is not a section name.
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
    const { saver, store, history } = options;
    for (const section of [saver, store, history]) {
      if (section !== undefined) assertObjectShape(section, 'options');
    }
    const logger = resolveLogger(this.base.logger);
    const resolved = resolveDynamoDBClient(this.base);
    const shared = { ...this.sharedDefaults(), client: resolved.client };
    // A section's own `s3` replaces the base one whole, so the region goes to
    // whichever of the two the adapter ends up with, once the two are merged.
    const onSharedClient = <Section extends { s3?: S3OffloadConfig }>(section: Section) => {
      const options = { ...shared, ...given(section) };
      return { ...options, s3: this.withTableRegion(options.s3) };
    };
    const built: Destroyable[] = [];
    // Record an adapter the moment it exists, so a later failure can still tear it down.
    const track = <T extends Destroyable>(adapter: T): T => {
      built.push(adapter);
      return adapter;
    };
    let destroyed = false;
    const destroy = (): void => {
      if (destroyed) return;
      destroyed = true;
      for (const adapter of built) release(logger, () => adapter.destroy());
      release(logger, () => resolved.ddbClient?.destroy());
    };
    try {
      const adapters: BuiltAdapters = {
        saver: saver && track(new DynamoDBSaver(onSharedClient(saver))),
        store: store && track(new DynamoDBStore(onSharedClient(store))),
        history: history && track(new DynamoDBChatMessageHistory(onSharedClient(history))),
        destroy,
      };
      return adapters as CreatedAdapters<O>;
    } catch (error) {
      destroy();
      throw error;
    }
  }
}
