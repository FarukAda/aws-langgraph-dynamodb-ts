import type { RunnableConfig } from '@langchain/core/runnables';
import {
  BaseCheckpointSaver,
  type ChannelVersions,
  type Checkpoint,
  type CheckpointListOptions,
  type CheckpointMetadata,
  type CheckpointTuple,
  type DeltaChannelHistory,
  type PendingWrite,
} from '@langchain/langgraph-checkpoint';

import { guardPublic, guardPublicIterable } from '../shared/errors/boundary';
import type { CancelOptions } from '../shared/options';
import { SAVER_KEYS } from '../shared/validation/adapter-keys';
import { assertCancelOptions, DELTA_CHANNEL_HISTORY_KEYS } from '../shared/validation/method-keys';
import { assertShape, checkedShape } from '../shared/validation/option-shape';
import { validateStringArray } from '../shared/validation/primitives';
import { deleteThread as deleteThreadAction } from './actions/delete-thread';
import { ensureS3Lifecycle } from './actions/ensure-lifecycle';
import { getCheckpointTuple } from './actions/get-tuple';
import { listCheckpoints } from './actions/list';
import { putCheckpoint } from './actions/put';
import { putWrites as putWritesAction } from './actions/put-writes';
import { assertConfigShape } from './internal/configurable';
import { deltaChannelHistory } from './internal/delta-history';
import { type CheckpointerContext, setUpCheckpointer } from './internal/setup';
import type { DeltaChannelHistoryOptions, DynamoDBSaverOptions } from './types';

/**
 * DynamoDB-backed LangGraph checkpoint saver. A thin orchestrator: it resolves
 * its collaborators once and delegates every operation to a focused action.
 * Every public method is the library's error boundary — a raw AWS SDK error
 * escaping an action surfaces as an `UpstreamError`.
 */
export class DynamoDBSaver extends BaseCheckpointSaver {
  private readonly context: CheckpointerContext;
  private readonly ownsClient: boolean;
  private readonly ddbClient: ReturnType<typeof setUpCheckpointer>['ddbClient'];

  /**
   * Accepts: `options` — validated here, so a misconfiguration surfaces at
   * construction rather than on the first request. `options.serde` reaches the
   * base class, which is why the resolved `this.serde` is what the context
   * gets.
   *
   * Returns: a saver that owns the client it built, or borrows the one it was
   * given.
   *
   * Throws: ValidationError naming the offending option.
   *
   * Guarantees: no I/O. Constructing a saver issues no request, so it is safe
   * at module scope and in a Lambda's init phase.
   */
  constructor(options: DynamoDBSaverOptions) {
    super(checkedShape(options, SAVER_KEYS, 'options').serde);
    const setup = setUpCheckpointer(options, this.serde);
    this.context = setup.context;
    this.ownsClient = setup.ownsClient;
    this.ddbClient = setup.ddbClient;
  }

  /**
   * Read one checkpoint with its metadata and pending writes.
   *
   * Accepts: `config` — an object; `config.configurable`, when present, an
   * object too. `config.configurable.checkpoint_id` — names the checkpoint, and
   * `thread_ts` is read in its place when it is absent; the absence of both
   * asks for the newest in the namespace. `checkpoint_ns` defaults to the root
   * namespace. A config naming no `thread_id` is accepted: its other
   * identifiers are still validated. `config.signal` — aborts the reads.
   *
   * Returns: the tuple, or `undefined` for an unknown thread, an unknown
   * checkpoint, a config naming no thread, or a checkpoint whose payload row is
   * not there yet.
   *
   * Throws: ValidationError, before any read, naming `config` for a config that
   * is not an object, `configurable` for a `configurable` that is present and
   * not an object, `signal` for a signal that is not `AbortSignal`-shaped, or
   * `thread_id`, `checkpoint_ns`, `checkpoint_id` or `thread_ts` for a
   * malformed identifier; `FORMAT_UNSUPPORTED` for a row a newer release wrote;
   * UpstreamError; RetryExhaustedError; AbortError.
   *
   * Guarantees: strongly consistent, so a checkpoint just written is always
   * seen.
   */
  async getTuple(config: RunnableConfig): Promise<CheckpointTuple | undefined> {
    return guardPublic('saver.getTuple', () => getCheckpointTuple(this.context, config));
  }

  /**
   * Stream checkpoints newest first.
   *
   * Accepts: `config` — one namespace, every namespace of a thread when
   * `checkpoint_ns` is omitted, or every thread in the table when `thread_id`
   * is omitted, which is a table scan, or a read of the recency index when
   * `indexName` is set. `options.before`, `options.filter` and
   * `options.limit` follow the reference savers; a limit of 0 or less yields
   * nothing.
   *
   * Returns: an async generator over the tuples. Abandoning it stops the read,
   * so a consumer that breaks early pays for no further page.
   *
   * Throws: ValidationError, raised from the first `.next()`, since a
   * generator runs none of its body until pulled, and before any read: naming
   * `config`, `configurable` or `signal` for a config of the wrong shape, as
   * {@link getTuple} does, or `thread_id`, `checkpoint_ns`, `checkpoint_id` or
   * `thread_ts` for a malformed identifier — all checked before `options`;
   * then `options` for options that are not an object, `options.<key>` for a
   * key this package does not read, `filter` for a filter that is not an
   * object, `limit` for a limit that is not an integer, and `before` for a
   * `before` that is not an object or whose `configurable.checkpoint_id` is
   * neither absent (`undefined`, `null` or `''`) nor a well-formed checkpoint
   * id. `FORMAT_UNSUPPORTED`; ResultTruncatedError, without a `thread_id` and
   * with `indexName`, for an index shard whose pages do not end; UpstreamError;
   * RetryExhaustedError; AbortError.
   *
   * Guarantees: eventually consistent — a listing tolerates the replica lag
   * `getTuple` does not.
   * @remarks One read per page — or, without a `thread_id` and with `indexName`,
   * at least one query per index shard per page of 100 rows — plus two per
   * yielded tuple (see the README cost table).
   */
  list(config: RunnableConfig, options?: CheckpointListOptions): AsyncGenerator<CheckpointTuple> {
    return guardPublicIterable('saver.list', listCheckpoints(this.context, config, options));
  }

  /**
   * Store a checkpoint and its metadata in one transaction.
   *
   * Accepts: `config` — shaped as {@link getTuple} requires, and naming a
   * `thread_id`. `config.configurable.checkpoint_id` — becomes the new
   * checkpoint's parent. `config.signal` — aborts the write. `checkpoint` —
   * every channel value it carries is stored. `newVersions` — accepted to
   * satisfy `BaseCheckpointSaver.put` and deliberately ignored; see
   * `putCheckpoint` for why narrowing by it lost state on a fork.
   *
   * Returns: the config addressing the stored checkpoint, which is what the
   * caller passes back to continue the thread.
   *
   * Throws: ValidationError naming `config`, `configurable` or `signal` for a
   * config of the wrong shape, `thread_id` for a missing or malformed thread
   * id, `checkpoint_ns`, `checkpoint_id` or `thread_ts` for a malformed
   * identifier, `checkpoint` for a `null` or `undefined` checkpoint,
   * `checkpoint_id` for a malformed `checkpoint.id`, `payload` for a payload
   * too large to store inline without `s3`, or `s3Key` for an offloaded
   * object's key over S3's cap; `S3_OFFLOAD_FAILED` when an offloaded payload
   * cannot be uploaded; UpstreamError; RetryExhaustedError; AbortError.
   *
   * Guarantees: both rows land or neither does. Writing the same
   * `checkpoint.id` again replaces both, so a retry is safe. Each put uploads
   * its offloaded payloads under an id of its own, so the objects the replaced
   * rows named are not deleted with them: they are left to the lifecycle rule
   * `ensureS3LifecycleRule()` provisions.
   */
  async put(
    config: RunnableConfig,
    checkpoint: Checkpoint,
    metadata: CheckpointMetadata,
    newVersions?: ChannelVersions,
  ): Promise<RunnableConfig> {
    return guardPublic('saver.put', () =>
      putCheckpoint(this.context, config, checkpoint, metadata, newVersions),
    );
  }

  /**
   * Store a task's pending writes for the checkpoint `config` names.
   *
   * Accepts: `config` — shaped as {@link getTuple} requires, naming a
   * `thread_id` and a `checkpoint_id`, since writes attach to a checkpoint.
   * `config.signal` — aborts the writes. `writes` — an array of
   * `[channel, value]` arrays, one row each, written in parallel; an empty list
   * writes nothing. `taskId` — validated as the key segment it becomes.
   *
   * Returns: nothing. Losing a first-write-wins race is a normal outcome, not
   * a failure.
   *
   * Throws: ValidationError naming `taskId` for a malformed task id; `config`,
   * `configurable` or `signal` for a config of the wrong shape; `thread_id`,
   * `checkpoint_ns`, `checkpoint_id` or `thread_ts` for a malformed
   * identifier, and `checkpoint_id` when the config names none; `writes` for
   * writes that is not an array, or holds an entry that is not one; `channel`
   * for a malformed channel; `sortKey` for identifiers composing a sort key
   * over DynamoDB's cap; `payload` for a value too large to store inline
   * without `s3`; or `s3Key` for an offloaded object's key over S3's cap.
   * `S3_OFFLOAD_FAILED`; UpstreamError; RetryExhaustedError; AbortError.
   *
   * Guarantees: regular writes are first-write-wins; special channels
   * (`__interrupt__`, `__resume__`, `__error__`, `__scheduled__`) overwrite,
   * with `s3` through a compare-and-swap on the row each call observed, so that
   * each call releases the payload it superseded rather than one a concurrent
   * call already replaced. An offloaded object can still be orphaned and left
   * to the lifecycle rule: when the compare-and-swap is exhausted and the write
   * overwrites unconditionally, when a delete fails, when the row cannot be read
   * before the write, when a failed write cannot be verified, or in one
   * double-fault interleaving (see the README's S3 offloading notes).
   */
  async putWrites(config: RunnableConfig, writes: PendingWrite[], taskId: string): Promise<void> {
    return guardPublic('saver.putWrites', () =>
      putWritesAction(this.context, config, writes, taskId),
    );
  }

  /**
   * Delete every checkpoint, payload and pending write of a thread.
   *
   * Accepts: `threadId` — validated. `options.signal` — aborts between pages.
   *
   * Returns: nothing. Deleting a thread that does not exist is not an error.
   *
   * Throws: ValidationError naming `options` for options that are not an
   * object, `options.<key>` for a key this package does not read, `signal`
   * for a signal that is not `AbortSignal`-shaped, or `thread_id` for a
   * malformed `threadId`;
   * BatchWriteAllIncompleteError when a row's delete fails, counting rows
   * rather than batches and carrying what did succeed; UpstreamError;
   * AbortError when the signal fires, which is what a cancel surfaces as
   * rather than an incomplete delete, even when it fires part-way through the
   * pass. A row refused because it was rewritten after the partition read
   * raises nothing: it is left exactly as its writer left it, reported at
   * `warn`, and counted as skipped.
   *
   * Guarantees: a row this adapter did not write is left in place and logged,
   * and neither is a row rewritten since the read — so an acknowledged write is
   * no longer erased, nor the object it names released, by a delete that
   * observed the row before it. Single pass: call it when the thread is
   * quiescent, since a checkpoint written at a key the read never saw survives
   * it, and so does the re-landing of an inline pending write, which carries no
   * request token on purpose. What comes back there is an ordinary row, naming
   * no object this call could have released.
   */
  async deleteThread(threadId: string, options?: CancelOptions): Promise<void> {
    return guardPublic('saver.deleteThread', () => {
      assertCancelOptions(options);
      return deleteThreadAction(this.context, threadId, options);
    });
  }

  /**
   * Walk a checkpoint's ancestors for the delta channels named, returning each
   * channel's on-path writes oldest-first and its nearest stored value.
   *
   * Overrides the inherited walk, which stops silently at an ancestor it cannot
   * read and lets the consumer restart the channel from empty. A TTL computed
   * per put puts that within reach here, so an ancestor a channel still needs
   * that has expired is reported instead of dropped; see `deltaChannelHistory`.
   *
   * Accepts: `options` — must be an object naming exactly `config` and
   * `channels`, the shape `BaseCheckpointSaver`'s own signature declares.
   * `options.channels` — the delta channels to rebuild, required; an empty
   * array reads nothing rather than being refused, since it is a legitimate
   * "nothing to rebuild" request. `options.config` — the checkpoint to walk
   * back from, shaped as {@link getTuple} requires and checked for that shape
   * even when there is nothing to read; its `signal` aborts the read of that
   * checkpoint.
   *
   * Returns: per channel, its on-path writes oldest-first and the nearest
   * stored value found.
   *
   * Throws: ValidationError naming `options` for options that are not an
   * object, `options.<key>` for an unknown key, `config`, `configurable` or
   * `signal` for a config of the wrong shape, or `channels` for a value that
   * is not an array of strings, and, once a channel is named, `thread_id`,
   * `checkpoint_ns`, `checkpoint_id` or `thread_ts` for a malformed
   * identifier; `ANCESTOR_EXPIRED` when a checkpoint a channel still needs has
   * expired; UpstreamError; RetryExhaustedError; AbortError.
   *
   * Guarantees: the walk stops at the first ancestor answering for every
   * channel, so a deep thread costs reads only as far back as the nearest
   * snapshot.
   */
  getDeltaChannelHistory(
    options: DeltaChannelHistoryOptions,
  ): Promise<Record<string, DeltaChannelHistory>> {
    return guardPublic('saver.getDeltaChannelHistory', () => {
      assertShape(options, DELTA_CHANNEL_HISTORY_KEYS, 'options');
      assertConfigShape(options.config);
      validateStringArray(options.channels, 'channels');
      return deltaChannelHistory(
        this.context,
        (c) => this.getTuple(c),
        options.config,
        options.channels,
      );
    });
  }

  /**
   * Release owned resources.
   *
   * Accepts: nothing.
   *
   * Returns: nothing. Idempotent, and a no-op for a client the caller injected
   * — that one is theirs to close.
   *
   * Throws: nothing this adapter raises.
   */
  destroy(): void {
    this.context.offloader?.destroy();
    if (this.ownsClient) this.ddbClient?.destroy();
  }

  /**
   * Provision an S3 lifecycle expiration rule matching the configured TTL, so
   * offloaded payloads don't outlive the items that point at them.
   *
   * Accepts: nothing; the rule follows the configured `s3` and `ttl`. A no-op
   * without both, since there would be no bucket to rule over or no expiry to
   * match.
   *
   * Returns: nothing. Installing a rule that is already there is a no-op too,
   * so calling it on every deploy is safe.
   *
   * Throws: ValidationError naming `s3.keyPrefix` on a rule-id collision;
   * UpstreamError when the bucket's lifecycle cannot be read or written.
   * @remarks Needs the bucket-level `s3:GetLifecycleConfiguration` and
   * `s3:PutLifecycleConfiguration` permissions, which are broader than the
   * object-level CRUD the rest of S3 offload needs. Call it once at deployment,
   * not per request.
   */
  async ensureS3LifecycleRule(): Promise<void> {
    return guardPublic('saver.ensureS3LifecycleRule', () => ensureS3Lifecycle(this.context));
  }
}
