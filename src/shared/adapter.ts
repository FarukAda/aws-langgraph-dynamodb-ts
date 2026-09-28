/**
 * Hides what an adapter owns for its lifetime, and how it lets go of it.
 *
 * Every adapter resolves the same things from its options — a DynamoDB client
 * it either built, and so must destroy, or was handed, and so must not; an S3
 * offloader when it offloads; a logger; a retry policy; the recency index's
 * settings — releases them the same way, and provisions the same lifecycle
 * rule from its ttl. Whether an adapter owns its client is decided in
 * `dynamodb/client.ts`; this module only reads that decision, to release a
 * client it built and leave an injected one alone.
 */

import type { CompressionConfig } from './codec/compression';
import { type AdapterName, offloaderConfigFor } from './codec/s3/config';
import { S3Offloader } from './codec/s3/offloader';
import { DEFAULT_READ_CONCURRENCY } from './concurrency';
import {
  type DynamoDBDocumentLike,
  resolveDynamoDBClient,
  warnOnStackedRetries,
} from './dynamodb/client';
import { DEFAULT_INDEX_SHARDS } from './dynamodb/recency-index';
import { type RetryOptions, resolveRetryPolicy } from './dynamodb/retry';
import { toError } from './errors/base-error';
import { type Logger, resolveLogger } from './logging/logger';
import type { BaseAdapterOptions, CodecOptions } from './options';
import { assertBaseCollaborators } from './validation/collaborators';
import { assertBaseAdapterOptions } from './validation/options';
import { lifecycleExpirationDays, type TtlOption } from './validation/ttl';

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

/** What every adapter resolves from its options and every operation reads. */
export interface AdapterCore {
  client: DynamoDBDocumentLike;
  tableName: string;
  compression?: CompressionConfig;
  offloader?: S3Offloader;
  ttl?: TtlOption;
  logger: Logger;
  /** Retry budget and backoff for every DynamoDB call, with the retry debug log attached. */
  retry?: RetryOptions;
  /**
   * Index partitions per adapter for the recency index; see `indexKeys`.
   * Absent means the default, which is where it is resolved.
   */
  indexShards?: number;
  /** Payloads decoded at once by one call; the memory ceiling’s multiplier. */
  readConcurrency?: number;
  /** Name of the recency index, when the table carries one; see `BaseAdapterOptions.indexName`. */
  indexName?: string;
}

/** An adapter's hold on what it owns. */
export interface AdapterShell {
  readonly core: AdapterCore;
  /** Provision the S3 lifecycle rule for the configured ttl; see {@link ensureLifecycleFor}. */
  ensureLifecycleRule(): Promise<void>;
  /**
   * Release the offloader, and the DynamoDB client when the adapter built it;
   * see {@link releaseOwned}. `release` runs once; a later call does nothing.
   */
  release(): void;
}

/** The checks an adapter adds to the shared ones, and where they run. */
export interface AdapterChecks {
  /** Runs after the shared option checks and before the collaborator checks. */
  options?: () => void;
  /** Runs after the shared collaborator checks, before anything is built. */
  collaborators?: () => void;
  /** The fewest attempts the adapter's own writes need; see `resolveRetryPolicy`. */
  attemptFloor?: number;
}

/** The options every adapter takes, with the serializer each may add. */
export type AdapterOptions = BaseAdapterOptions & CodecOptions & { serde?: object };

/**
 * Provision the S3 lifecycle rule that expires what an adapter offloads, on its
 * ttl, so an offloaded payload does not outlive the DynamoDB item that points
 * at it.
 *
 * The rule is expressed in whole days because that is the only granularity S3
 * lifecycle expiration accepts, while the DynamoDB TTL is in seconds; see
 * `lifecycleExpirationDays` for the rounding, which is always up.
 *
 * Accepts: `core` — the adapter's offloader, ttl and logger.
 *
 * Returns: nothing. Without an offloader there is nothing to rule over, and
 * without a ttl no item expires, so any rule would delete a payload a live row
 * still needs: either absence does nothing. Installing a rule that is already
 * there is a no-op too, so calling this on every deploy is safe. When it
 * writes the rules but cannot confirm within its polling window that a
 * re-read shows them — S3 documents that a lifecycle configuration can take
 * minutes to propagate — it logs a `warn` and returns rather than throwing:
 * the rules were written, and a later call can confirm them.
 *
 * Throws: whatever reading or writing the bucket's lifecycle configuration
 * throws, `VALIDATION` naming `s3.keyPrefix` when the rule id this prefix
 * would take is already held by a different prefix, and `CONTENTION` when
 * every one of the five rounds this call polls needs a write — a competing
 * writer replacing the configuration on every single re-read.
 *
 * Guarantees: needs the bucket-level `s3:GetLifecycleConfiguration` /
 * `s3:PutLifecycleConfiguration` permissions, which are broader than the
 * object-level CRUD the rest of offload uses — so this is a provisioning call,
 * not a per-request one.
 */
export async function ensureLifecycleFor(
  core: Pick<AdapterCore, 'offloader' | 'ttl' | 'logger'>,
): Promise<void> {
  if (!core.offloader || !core.ttl) return;
  await core.offloader.ensureLifecycleRule(lifecycleExpirationDays(core.ttl), core.logger);
}

/**
 * Check an adapter's options and resolve what it will own.
 *
 * Accepts: `options` — the adapter's, already held to its own key list, and
 * checked first, so no half-built adapter exists when one is wrong.
 * `adapter` — which adapter, which names its default S3 key prefix. `checks` —
 * the adapter's own option and collaborator checks, and its retry floor.
 *
 * Returns: the shell: the core every operation reads, with every shared
 * default filled in here and nowhere else, and the adapter's two lifetime
 * operations. A client the caller passed in is never destroyed by `release`.
 *
 * Throws: `VALIDATION` for an option or a collaborator that fails a shared
 * check or one of `checks`, in that order.
 *
 * Guarantees: no I/O. The stacked-retry check is deliberately not awaited: it
 * is a warning about a caller-supplied client, not a precondition.
 */
export function openAdapter(
  options: AdapterOptions,
  adapter: AdapterName,
  checks: AdapterChecks = {},
): AdapterShell {
  assertBaseAdapterOptions(options);
  checks.options?.();
  assertBaseCollaborators(options);
  checks.collaborators?.();
  const logger = resolveLogger(options.logger);
  const resolved = resolveDynamoDBClient(options);
  if (!resolved.ownsClient) void warnOnStackedRetries(resolved.client, logger);
  const offloader = options.s3
    ? new S3Offloader(offloaderConfigFor(options.s3, adapter, options.clientConfig), logger)
    : undefined;
  const core: AdapterCore = {
    client: resolved.client,
    tableName: options.tableName,
    compression: options.compression,
    offloader,
    ttl: options.ttl,
    logger,
    retry: resolveRetryPolicy(options.retry, logger, checks.attemptFloor),
    indexShards: options.indexShards ?? DEFAULT_INDEX_SHARDS,
    readConcurrency: options.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    indexName: options.indexName,
  };
  let released = false;
  return {
    core,
    ensureLifecycleRule: () => ensureLifecycleFor(core),
    release: () => {
      // A second call has nothing left to release, and a client's own destroy
      // need not be safe to repeat.
      if (released) return;
      released = true;
      releaseOwned([offloader, resolved.ownsClient ? resolved.ddbClient : undefined]);
    },
  };
}
