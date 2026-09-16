import { ValidationError } from '../errors/errors';

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
 * Refuse a collaborator missing a method this package calls.
 *
 * Checked by shape, never `instanceof`: the rule is banned repo-wide, and a
 * duck-typed check also survives two copies of a dependency in one tree, which
 * is exactly the situation an injected client comes from.
 *
 * Accepts: `value` — the collaborator as the caller gave it. `members` — every
 * method this package calls on it. `field` — what the error names.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `field` for a non-object, and `field.member`
 * for the first missing method — naming which member is missing is what turns
 * a first-request crash into a startup error a caller can act on.
 */
export function assertMembers(value: object, members: readonly string[], field: string): void {
  if (typeof value !== 'object' || value === null) {
    throw new ValidationError(`${field} must be an object`, field);
  }
  for (const member of members) {
    if (typeof Reflect.get(value, member) !== 'function') {
      throw new ValidationError(`${field}.${member} must be a function`, `${field}.${member}`);
    }
  }
}

/**
 * Validate the collaborators every adapter shares: `client`, `logger` and
 * `serde`. Pulled out of each `setUp*` as one call rather than three inline
 * checks, which is also what keeps `setUpStore`/`setUpHistory` under the
 * complexity cap.
 *
 * Accepts: `options` — the adapter options, narrowed to the three shared
 * collaborator fields. Every field here is typed as `object`, which a real
 * `DynamoDBDocument`, `Logger` or `SerializerProtocol` all satisfy, so any
 * adapter's options type is assignable without a cast.
 *
 * Returns: nothing; validity is the absence of a throw. A collaborator the
 * caller did not supply is left untouched, so it still reaches its default.
 *
 * Throws: see {@link assertMembers}.
 */
export function assertBaseCollaborators(options: {
  client?: object;
  logger?: object;
  serde?: object;
}): void {
  if (options.client !== undefined) assertMembers(options.client, CLIENT_MEMBERS, 'client');
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
 * Returns: `true` when `value` is a non-null object exposing a boolean
 * `aborted` and a callable `addEventListener` — `false` otherwise, including
 * for `undefined`.
 *
 * Throws: nothing.
 */
export function isAbortSignalLike(value: AbortSignal | undefined): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof value.aborted === 'boolean' &&
    typeof value.addEventListener === 'function'
  );
}

/**
 * Throw {@link ValidationError} naming `signal` unless `value` is absent or
 * {@link isAbortSignalLike}.
 *
 * Accepts: `value` — a caller's `options.signal`, or `undefined`.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: ValidationError naming `signal`. Left unchecked, a value that is
 * not an `AbortSignal` reaches whatever this package hands it to — an
 * `addEventListener` call, a retry loop reading `.aborted` — and fails there
 * with a raw, unrelated error instead of naming the option that caused it.
 */
export function assertSignalLike(value: AbortSignal | undefined): void {
  if (value !== undefined && !isAbortSignalLike(value)) {
    throw new ValidationError('signal must be an AbortSignal', 'signal');
  }
}
