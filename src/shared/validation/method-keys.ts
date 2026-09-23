import type { CancelOptions } from '../options';
import { assertSignalLike } from './collaborators';
import { allKeysOf, assertShape } from './option-shape';

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
