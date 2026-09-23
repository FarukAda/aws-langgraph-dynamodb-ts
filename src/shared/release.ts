import { toError } from './errors/to-error';

/** Anything an adapter holds open and must hand back when it is torn down. */
export interface Releasable {
  destroy(): void;
}

/**
 * Release every resource, whatever any one of them does.
 *
 * The hazard is the one `DynamoDBFactory`'s own `release` names: a teardown
 * written as a sequence of statements stops at the first throw, so everything
 * after it is stranded with no reference left to reach it by. Each adapter's
 * `destroy` was exactly that sequence — the S3 offloader, then the DynamoDB
 * client it built — and an S3 client whose sockets are already gone throws from
 * its own `destroy`, so the DynamoDB client leaked for the life of the process.
 *
 * Accepts: `resources` — in the order they should be released; an absent one
 * (an adapter with no offloader, a client the caller injected and therefore
 * owns) is skipped rather than guarded at each call site.
 *
 * Returns: nothing.
 *
 * Throws: the **first** failure, and only after every resource has been
 * offered its release, so nothing is stranded behind it. Raised rather than
 * logged because the default logger discards everything: a caller who never
 * configured one would otherwise be told nowhere at all that a client of theirs
 * is still holding sockets. A later failure is dropped, because a caller can
 * act on one report and the first one names the resource that actually broke.
 * A `throw` that produced something other than an `Error` is normalised, so a
 * caller's `catch` is handed the same shape whatever a client raised.
 */
export function releaseOwned(resources: readonly (Releasable | undefined)[]): void {
  let first: Error | undefined;
  for (const resource of resources) {
    try {
      resource?.destroy();
    } catch (error) {
      first ??= toError(error as Error);
    }
  }
  if (first !== undefined) throw first;
}
