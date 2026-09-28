/**
 * Hides what a collaborator a caller hands in must offer.
 *
 * An injected client, logger, serde, embeddings model or vector backend is
 * checked by the members this package calls on it, and a cancellation signal
 * — at construction or on a single call's options — by the members an
 * `AbortSignal` has, so a wrong object fails where it was passed and not at the
 * first call deep inside an operation.
 */

import { validationError } from '../errors/errors';
import type { CancelOptions } from '../options';
import { allKeysOf, assertShape, isObjectShape } from './option-shape';

/** The `DynamoDBDocument` methods this package calls on an injected `client`. */
export const CLIENT_MEMBERS: readonly string[] = [
  'get',
  'put',
  'delete',
  'update',
  'query',
  'scan',
  'batchWrite',
  'transactWrite',
];

/** The `Logger` methods every adapter calls. */
export const LOGGER_MEMBERS: readonly string[] = ['debug', 'info', 'warn', 'error'];

/** The `SerializerProtocol` methods this package calls on `serde`. */
export const SERDE_MEMBERS: readonly string[] = ['dumpsTyped', 'loadsTyped'];

/** The `Embeddings` methods this package calls on `index.embeddings`. */
export const EMBEDDINGS_MEMBERS: readonly string[] = ['embedQuery', 'embedDocuments'];

/**
 * The `VectorBackend` methods this package calls. `listKeys` is deliberately
 * excluded: it is optional on the interface (`store/vector-backend.ts`), and
 * `reconcileVectorIndex` already branches on its absence and logs instead of
 * requiring it — requiring it here would refuse a backend shape this package
 * documents and supports.
 */
export const VECTOR_BACKEND_MEMBERS: readonly string[] = ['upsert', 'query', 'delete'];

/**
 * Every `AbortSignal` member this package uses on a caller's `signal`, with
 * the `typeof` each must have: `aborted` is read before a request and between
 * pages, and the wait between retries attaches an abort listener and removes
 * it again from inside its timer. `reason` is only read, which is safe on any
 * object, so it is not required.
 */
export const ABORT_SIGNAL_MEMBERS: Readonly<Record<string, 'boolean' | 'function'>> = {
  aborted: 'boolean',
  addEventListener: 'function',
  removeEventListener: 'function',
};

/**
 * Refuse a collaborator missing a method this package calls.
 *
 * Checked by shape, never `instanceof`: the rule is banned repo-wide, and a
 * duck-typed check also survives two copies of a dependency in one tree, which
 * is exactly the situation an injected client comes from.
 *
 * Accepts: `value` — the collaborator as the caller gave it. `members` — every
 * method this package calls on it. `field` — what the error names.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field` for a non-object, `null` or an array,
 * and `field.member` for the first missing method — naming which member is
 * missing is what turns a first-request crash into a startup error a caller
 * can act on. An array is refused as a whole rather than reported as missing
 * its first method, which would point the caller at a method instead of at
 * the value.
 */
export function assertMembers(value: object, members: readonly string[], field: string): void {
  if (!isObjectShape(value)) {
    throw validationError(`${field} must be an object`, field);
  }
  for (const member of members) {
    if (typeof Reflect.get(value, member) !== 'function') {
      throw validationError(`${field}.${member} must be a function`, `${field}.${member}`);
    }
  }
}

/** The part of a `DynamoDBDocument` that says how it converts between JavaScript values and attributes. */
interface TranslatingClient {
  config?: {
    translateConfig?: {
      marshallOptions?: { convertEmptyValues?: boolean };
      unmarshallOptions?: {
        wrapNumbers?: boolean | ((value: string) => number | bigint | string | object);
      };
    };
  };
}

/**
 * Refuse an injected client whose document translation changes what this
 * package writes or reads back.
 *
 * Accepts: `client` — the injected document client, or any object standing in
 * for one; one without `config.translateConfig` translates the default way.
 *
 * Returns: nothing: the client is kept under its declared type, and this checks it.
 *
 * Throws: `VALIDATION` naming `client` when its `unmarshallOptions.wrapNumbers`
 * is set — every number this package reads back (a row's format version, a
 * `ttl`, a message count) would arrive wrapped, so a newer row would read as
 * version 0 and a session as malformed — or when its
 * `marshallOptions.convertEmptyValues` is on, which stores the root checkpoint
 * namespace, the empty string, as NULL.
 */
export function assertClientTranslation(client: object): void {
  const translate = (client as TranslatingClient).config?.translateConfig;
  if (translate?.unmarshallOptions?.wrapNumbers) {
    throw validationError(
      'client reads numbers back wrapped (unmarshallOptions.wrapNumbers), where this package ' +
        'reads a row version, a ttl and a count as numbers; inject a DynamoDBDocument built ' +
        'without it',
      'client',
    );
  }
  if (translate?.marshallOptions?.convertEmptyValues === true) {
    throw validationError(
      'client stores an empty string as NULL (marshallOptions.convertEmptyValues), which erases ' +
        'the root checkpoint namespace; inject a DynamoDBDocument built without it',
      'client',
    );
  }
}

/**
 * Validate the collaborators every adapter shares: `client`, `logger` and
 * `serde`. Pulled out of each `setUp*` as one call rather than three inline
 * checks, so the three adapters check them the same way.
 *
 * Accepts: `options` — the adapter options, narrowed to the three shared
 * collaborator fields. Every field here is typed as `object`, which a real
 * `DynamoDBDocument`, `Logger` or `SerializerProtocol` all satisfy, so any
 * adapter's options type is assignable without a cast.
 *
 * Returns: nothing: each collaborator given is kept under its declared type,
 * and this checks it. A collaborator the caller did not supply is left
 * untouched, so it still reaches its default.
 *
 * Throws: see {@link assertMembers} for a collaborator missing a method, and
 * {@link assertClientTranslation} for a `client` whose translation would
 * change how a row reads back.
 */
export function assertBaseCollaborators(options: {
  client?: object;
  logger?: object;
  serde?: object;
}): void {
  if (options.client !== undefined) {
    assertMembers(options.client, CLIENT_MEMBERS, 'client');
    assertClientTranslation(options.client);
  }
  if (options.logger !== undefined) assertMembers(options.logger, LOGGER_MEMBERS, 'logger');
  if (options.serde !== undefined) assertMembers(options.serde, SERDE_MEMBERS, 'serde');
}

/**
 * A value usable as an `AbortSignal`, checked by shape.
 *
 * `signal` is not a method bag like the collaborators above, so this returns
 * a boolean rather than throwing: it never needs to be paired with the
 * caller's own decision about what an absent signal means.
 *
 * Accepts: `value` — the caller's `signal`, or `undefined`.
 *
 * Returns: `true` when `value` is a non-null object whose every member in
 * {@link ABORT_SIGNAL_MEMBERS} has the type listed there — `false` otherwise,
 * including for `undefined`.
 *
 * Throws: nothing.
 */
export function isAbortSignalLike(value: AbortSignal | undefined): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(ABORT_SIGNAL_MEMBERS).every(
    ([member, type]) => typeof Reflect.get(value, member) === type,
  );
}

/**
 * Throw `VALIDATION` naming `field` unless `value` is absent or
 * {@link isAbortSignalLike}.
 *
 * Accepts: `value` — a caller's signal, or `undefined`. `field` — what the
 * error names; `signal` by default, and the full path for a signal nested in
 * another option (`retry.signal`), so a caller whose top-level `signal` is
 * valid is not pointed at it.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `field`. Left unchecked, a value that is not
 * an `AbortSignal` reaches whatever this package hands it to — an
 * `addEventListener` call, a retry loop reading `.aborted`, a
 * `removeEventListener` call from inside a timer, where nothing can catch it —
 * and fails there with a raw, unrelated error instead of naming the option
 * that caused it.
 */
export function assertSignalLike(value: AbortSignal | undefined, field = 'signal'): void {
  if (value !== undefined && !isAbortSignalLike(value)) {
    throw validationError(`${field} must be an AbortSignal`, field);
  }
}

/**
 * The keys of a cancellation-only option bag, exhaustive in both directions.
 *
 * Every feature's own option-bag lists live in that feature's `internal/`
 * directory, beside the types they are checked against;
 * `shared/` knows no feature. This one stays here because `CancelOptions` is
 * shared by all three. `allKeysOf<T>` keeps the list from drifting from the
 * type it guards: an exhaustive list compiles, omitting or inventing a key
 * does not.
 */
export const CANCEL_KEYS = allKeysOf<CancelOptions>({ signal: 'signal' });

/**
 * Reject a `{ signal }` bag carrying a key this package does not read.
 *
 * Pulled out as one call because several methods across three classes take
 * only cancellation (`addMessages`, `addMessage`, `clear`,
 * `reconcileMessageCount`, `deleteThread`, `reconcileVectorIndex`) — one
 * shared check keeps their wording and their key list from drifting apart.
 *
 * Accepts: `options` — as the caller passed it; absent is left alone, since
 * there is nothing to check.
 *
 * Returns: nothing: the value is kept under its declared type, and this
 * checks it.
 *
 * Throws: `VALIDATION` naming `options.<key>` for the first key this
 * package does not read, or `signal` for a value that is not AbortSignal-like.
 */
export function assertCancelOptions(options: CancelOptions | undefined): void {
  if (options === undefined) return;
  assertShape(options, CANCEL_KEYS, 'options');
  assertSignalLike(options.signal);
}
