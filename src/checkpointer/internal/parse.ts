import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  Checkpoint,
  CheckpointListOptions,
  CheckpointMetadata,
  PendingWrite,
} from '@langchain/langgraph-checkpoint';

import {
  MAX_KEY_SEGMENT_BYTES,
  MAX_PARTITION_ID_BYTES,
  MAX_SORT_KEY_BYTES,
} from '../../shared/constants';
import { validationError } from '../../shared/errors/errors';
import { assertSignalLike } from '../../shared/validation/collaborators';
import { assertObjectShape, assertShape } from '../../shared/validation/option-shape';
import {
  type PageLimit,
  parseIdentifier,
  parseKeySegment,
  parseLimit,
  parseStringArray,
} from '../../shared/validation/primitives';
import type { CheckpointConfigurable, DeltaChannelHistoryOptions } from '../types';
import type { FilterValue } from './filter-match';
import { SORT_KEY_SEPARATOR, writeSortKeyBytes } from './keys';
import { DELTA_CHANNEL_HISTORY_KEYS, SAVER_LIST_KEYS } from './option-keys';

declare const threadIdBrand: unique symbol;
declare const checkpointNsBrand: unique symbol;
declare const checkpointIdBrand: unique symbol;
declare const taskIdBrand: unique symbol;
declare const writeChannelBrand: unique symbol;

/**
 * A thread id checked as the partition key it becomes. {@link parseThreadId}
 * is the only way to obtain one, so a function that asks for a `ThreadId`
 * cannot be handed an id nobody checked, and does not check it again. The
 * brand is phantom: at run time it is the caller's own string.
 */
export type ThreadId = string & { readonly [threadIdBrand]: true };

/** A checkpoint namespace checked as a key segment; `''` is the root. Built only by {@link parseCheckpointNs}. */
export type CheckpointNs = string & { readonly [checkpointNsBrand]: true };

/** A checkpoint id checked as a key segment. Built only by {@link parseCheckpointId}. */
export type CheckpointId = string & { readonly [checkpointIdBrand]: true };

/** A task id checked as a key segment. Built only by {@link parseTaskId}. */
export type TaskId = string & { readonly [taskIdBrand]: true };

/** A pending write's channel checked as the key segment it becomes. Built only by {@link parseWriteChannel}. */
export type WriteChannel = string & { readonly [writeChannelBrand]: true };

/**
 * Parse a thread id.
 *
 * Accepts: `value` — anything; a thread id reaches the partition key, so it is
 * held to every identifier rule at {@link MAX_PARTITION_ID_BYTES}.
 *
 * Returns: `value` as a {@link ThreadId}.
 *
 * Throws: `VALIDATION` naming `thread_id`.
 */
export function parseThreadId(value: unknown): ThreadId {
  return parseIdentifier(
    value,
    SORT_KEY_SEPARATOR,
    'thread_id',
    MAX_PARTITION_ID_BYTES,
  ) as ThreadId;
}

/**
 * Parse a checkpoint namespace.
 *
 * Accepts: `value` — anything; `''` is legal, because it *is* the root
 * namespace, and every other identifier rule applies (see `parseKeySegment`).
 *
 * Returns: `value` as a {@link CheckpointNs}.
 *
 * Throws: `VALIDATION` naming `checkpoint_ns`.
 */
export function parseCheckpointNs(value: unknown): CheckpointNs {
  return parseKeySegment(
    value,
    SORT_KEY_SEPARATOR,
    'checkpoint_ns',
    MAX_KEY_SEGMENT_BYTES,
  ) as CheckpointNs;
}

/**
 * Parse a checkpoint id.
 *
 * Accepts: `value` — anything. `field` — the field the caller set:
 * `checkpoint_id` by default, `thread_ts` when the id was read from that legacy
 * alias, `before` for `list`'s bound, so the refusal names what the caller
 * actually wrote.
 *
 * Returns: `value` as a {@link CheckpointId}.
 *
 * Throws: `VALIDATION` naming `field`.
 */
export function parseCheckpointId(
  value: unknown,
  field: 'checkpoint_id' | 'thread_ts' | 'before' = 'checkpoint_id',
): CheckpointId {
  return parseIdentifier(value, SORT_KEY_SEPARATOR, field, MAX_KEY_SEGMENT_BYTES) as CheckpointId;
}

/**
 * Parse a task id. LangGraph's own are UUIDs; the rule is stated for whatever
 * else a caller passes.
 *
 * Accepts: `value` — anything.
 *
 * Returns: `value` as a {@link TaskId}.
 *
 * Throws: `VALIDATION` naming `taskId`.
 */
export function parseTaskId(value: unknown): TaskId {
  return parseIdentifier(value, SORT_KEY_SEPARATOR, 'taskId', MAX_KEY_SEGMENT_BYTES) as TaskId;
}

/**
 * Parse a pending write's channel, the trailing segment of its WRITE sort key.
 *
 * Accepts: `value` — anything; LangGraph's own channel names never contain the
 * reserved separator.
 *
 * Returns: `value` as a {@link WriteChannel}.
 *
 * Throws: `VALIDATION` naming `channel`.
 */
export function parseWriteChannel(value: unknown): WriteChannel {
  return parseIdentifier(
    value,
    SORT_KEY_SEPARATOR,
    'channel',
    MAX_KEY_SEGMENT_BYTES,
  ) as WriteChannel;
}

/** The root namespace, which a config that names none addresses. */
export const ROOT_NAMESPACE: CheckpointNs = parseCheckpointNs('');

/** A thread, a namespace in it, and possibly one checkpoint — "the newest" when unset. */
export interface ThreadAddress {
  readonly threadId: ThreadId;
  readonly checkpointNs: CheckpointNs;
  readonly checkpointId: CheckpointId | undefined;
}

/** A thread address that names one checkpoint. */
export interface CheckpointAddress extends ThreadAddress {
  readonly checkpointId: CheckpointId;
}

/** What a config names, parsed. A read accepts a config that names no thread. */
export interface ParsedConfig {
  readonly threadId: ThreadId | undefined;
  /** `undefined` only when the config names no `checkpoint_ns` at all; `null` reads as the root, named. */
  readonly checkpointNs: CheckpointNs | undefined;
  readonly checkpointId: CheckpointId | undefined;
  readonly signal: AbortSignal | undefined;
}

/** A config that names a thread, with its namespace defaulted to the root. */
export interface ThreadConfig {
  readonly address: ThreadAddress;
  readonly signal: AbortSignal | undefined;
}

/**
 * Whether `value` is one of the three markers a config treats as "no id here":
 * exactly `undefined`, `null` and `''`. Not JavaScript truthiness: `0`, `false`
 * and `NaN` are values to parse, and refuse, not absences.
 */
function isAbsentId(value: string | undefined): boolean {
  return value === undefined || value === null || value === '';
}

/**
 * Refuse a config whose own shape this package cannot read, before any
 * identifier is read from it. A `null` or `undefined` config otherwise reached
 * a bare `TypeError`; a `configurable` that is not an object read as a config
 * naming no thread, so `list` scanned every thread in the table; a signal that
 * is not `AbortSignal`-shaped failed only inside a retry's wait.
 */
function checkConfigShape(config: RunnableConfig): void {
  assertObjectShape(config, 'config');
  if (config.configurable !== undefined) assertObjectShape(config.configurable, 'configurable');
  assertSignalLike(config.signal);
}

/** A shape-checked config's `configurable`, `{}` when it has none. */
function configurableOf(config: RunnableConfig): CheckpointConfigurable {
  checkConfigShape(config);
  return (config.configurable ?? {}) as CheckpointConfigurable;
}

/** The namespace a `configurable` names, or `undefined` when it names none. */
function namespaceOf(configurable: CheckpointConfigurable): CheckpointNs | undefined {
  if (configurable.checkpoint_ns === undefined) return undefined;
  return parseCheckpointNs(configurable.checkpoint_ns ?? '');
}

/**
 * A config's checkpoint id, resolved the way the reference's `getCheckpointId`
 * does — `checkpoint_id || thread_ts || ''` (`@langchain/langgraph-checkpoint`
 * `dist/base.js:169-171`) — but against exactly the three absence markers of
 * {@link isAbsentId}, so `checkpoint_id: 0` is refused as the malformed id it
 * is rather than falling through to `thread_ts` or reading as "the newest".
 */
function resolveCheckpointId(configurable: CheckpointConfigurable): CheckpointId | undefined {
  if (!isAbsentId(configurable.checkpoint_id)) return parseCheckpointId(configurable.checkpoint_id);
  if (!isAbsentId(configurable.thread_ts)) {
    return parseCheckpointId(configurable.thread_ts, 'thread_ts');
  }
  return undefined;
}

/**
 * Parse a config a read accepts, naming a thread or not.
 *
 * Accepts: `config` — an object; `configurable` absent or an object; `signal`
 * absent or `AbortSignal`-shaped. A config naming no thread is legal: the
 * identifiers it does give are still parsed, as the reference saver does
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/memory.js:86-92`).
 *
 * Returns: the thread, the namespace as given (`undefined` when not named), the
 * checkpoint id (`undefined` for "the newest"), and the signal.
 *
 * Throws: `VALIDATION` naming `config`, `configurable` or `signal` for a config
 * of the wrong shape, then `thread_id`, `checkpoint_ns`, `checkpoint_id` or
 * `thread_ts`, in that order.
 */
export function parseConfig(config: RunnableConfig): ParsedConfig {
  const configurable = configurableOf(config);
  const threadId =
    configurable.thread_id === undefined ? undefined : parseThreadId(configurable.thread_id);
  return {
    threadId,
    checkpointNs: namespaceOf(configurable),
    checkpointId: resolveCheckpointId(configurable),
    signal: config.signal,
  };
}

/**
 * Parse a config a write needs: one that names a thread.
 *
 * Accepts: `config` — as {@link parseConfig}, with `thread_id` required.
 *
 * Returns: the address, its namespace defaulted to {@link ROOT_NAMESPACE}, and
 * the signal.
 *
 * Throws: as {@link parseConfig}; a missing `thread_id` is refused naming
 * `thread_id`, before the namespace is read.
 */
export function parseThreadConfig(config: RunnableConfig): ThreadConfig {
  const configurable = configurableOf(config);
  const threadId = parseThreadId(configurable.thread_id);
  return {
    address: {
      threadId,
      checkpointNs: namespaceOf(configurable) ?? ROOT_NAMESPACE,
      checkpointId: resolveCheckpointId(configurable),
    },
    signal: config.signal,
  };
}

/** Everything one `put` stores, parsed. */
export interface PutRequest {
  /** The new checkpoint's own address: its `checkpointId` is `checkpoint.id`. */
  readonly address: CheckpointAddress;
  /** The checkpoint the config named, which the new one continues. */
  readonly parentCheckpointId: CheckpointId | undefined;
  readonly checkpoint: Checkpoint;
  readonly metadata: CheckpointMetadata;
  readonly signal: AbortSignal | undefined;
}

/**
 * Parse the arguments of `put`.
 *
 * Accepts: `config` — as {@link parseThreadConfig}; its checkpoint id becomes
 * the parent. `checkpoint` — must be present; its `id` is parsed as the key
 * segment it becomes. `metadata` — stored as given.
 *
 * Returns: the request every later step of the put reads.
 *
 * Throws: as {@link parseThreadConfig}; then `VALIDATION` naming `checkpoint`
 * for a `null` or `undefined` checkpoint, or `checkpoint_id` for a malformed
 * `checkpoint.id`.
 */
export function parsePutRequest(
  config: RunnableConfig,
  checkpoint: Checkpoint,
  metadata: CheckpointMetadata,
): PutRequest {
  const { address, signal } = parseThreadConfig(config);
  if (checkpoint === null || checkpoint === undefined) {
    throw validationError('checkpoint must be an object', 'checkpoint');
  }
  const checkpointId = parseCheckpointId(checkpoint.id);
  return {
    address: { threadId: address.threadId, checkpointNs: address.checkpointNs, checkpointId },
    parentCheckpointId: address.checkpointId,
    checkpoint,
    metadata,
    signal,
  };
}

/** Everything one `putWrites` stores, parsed. */
export interface PutWritesRequest {
  readonly address: CheckpointAddress;
  readonly taskId: TaskId;
  /** A copy of the caller's writes, each reduced to its channel and value. */
  readonly writes: PendingWrite<WriteChannel>[];
  readonly signal: AbortSignal | undefined;
}

/**
 * Refuse a `writes` argument that cannot be read as the tuples it is typed to
 * hold: a non-array, or an entry that is not itself an array. Every entry is
 * checked before any channel is, so a call with both faults names `writes`.
 *
 * Indexed by position rather than `Array.prototype.forEach`, which skips a
 * hole in a sparse array (`[, ['a', 1]]`) instead of visiting it: a skipped
 * hole read as `undefined` downstream, past every later `.map` this parser
 * runs over the same array, and reached the `WriteChannel` brand unparsed.
 */
function checkWriteEntries(writes: PendingWrite[]): void {
  if (!Array.isArray(writes)) {
    throw validationError('writes must be an array', 'writes');
  }
  for (let index = 0; index < writes.length; index += 1) {
    if (!Array.isArray(writes[index])) {
      throw validationError(`writes[${index}] must be a [channel, value] tuple`, 'writes');
    }
  }
}

/**
 * Refuse a write whose composed WRITE sort key would pass DynamoDB's cap.
 * Every segment is capped on its own, and four capped segments together still
 * exceed it.
 */
function checkWriteKeyFits(
  address: CheckpointAddress,
  taskId: TaskId,
  channel: WriteChannel,
): void {
  const bytes = writeSortKeyBytes(address.checkpointNs, address.checkpointId, taskId, channel);
  if (bytes > MAX_SORT_KEY_BYTES) {
    throw validationError(
      `checkpoint_ns, checkpoint_id, taskId and channel compose a ${bytes}-byte sort key; ` +
        `DynamoDB caps sort keys at ${MAX_SORT_KEY_BYTES} bytes`,
      'sortKey',
    );
  }
}

/**
 * Parse the arguments of `putWrites`.
 *
 * Accepts: `config` — as {@link parseThreadConfig}, and it must name a
 * checkpoint, since writes attach to one. `writes` — an array of
 * `[channel, value]` arrays; the value, and any element past the second, are
 * unconstrained, as upstream's type places no rule on them. `taskId` — parsed
 * as the key segment it becomes.
 *
 * Returns: the request, with a fresh array of fresh tuples, so a caller
 * changing its own array while the call awaits changes nothing that was
 * checked.
 *
 * Throws: `VALIDATION`, before anything is encoded or uploaded, in this order:
 * `taskId`; as {@link parseThreadConfig}; `checkpoint_id` when the config names
 * none; `writes` for a non-array or an entry that is not one; `channel` for any
 * malformed channel; `sortKey` for any write whose composed key passes the cap.
 */
export function parsePutWritesRequest(
  config: RunnableConfig,
  writes: PendingWrite[],
  taskId: string,
): PutWritesRequest {
  const parsedTaskId = parseTaskId(taskId);
  const { address, signal } = parseThreadConfig(config);
  if (address.checkpointId === undefined) {
    throw validationError('checkpoint_id is required to store writes', 'checkpoint_id');
  }
  const target: CheckpointAddress = {
    threadId: address.threadId,
    checkpointNs: address.checkpointNs,
    checkpointId: address.checkpointId,
  };
  checkWriteEntries(writes);
  const channels = writes.map(([channel]) => parseWriteChannel(channel));
  for (const channel of channels) checkWriteKeyFits(target, parsedTaskId, channel);
  return {
    address: target,
    taskId: parsedTaskId,
    writes: writes.map(([, value], index): PendingWrite<WriteChannel> => [channels[index], value]),
    signal,
  };
}

/** What one `list()` call covers, parsed once from its config and options. */
export interface ListScope {
  /** Undefined when the caller gave no `thread_id`: every thread in the table is listed. */
  readonly threadId: ThreadId | undefined;
  /** Undefined when the caller gave no `checkpoint_ns`: every namespace of the thread is listed. */
  readonly checkpointNs: CheckpointNs | undefined;
  readonly checkpointId: CheckpointId | undefined;
  readonly before: CheckpointId | undefined;
  readonly filter: Record<string, FilterValue> | undefined;
  readonly limit: PageLimit | undefined;
  readonly signal: AbortSignal | undefined;
}

/**
 * `options.before`'s checkpoint id, parsed the way a config's is: exactly
 * `undefined`, `null` and `''` mean no bound, anything else is parsed as the
 * key segment it is compared with. Left unchecked, a non-string made every
 * row fail the comparison and the listing came back silently empty.
 */
function beforeCheckpointId(before: RunnableConfig | undefined): CheckpointId | undefined {
  if (before === undefined) return undefined;
  assertObjectShape(before, 'before');
  const checkpointId = before.configurable?.checkpoint_id;
  if (isAbsentId(checkpointId)) return undefined;
  return parseCheckpointId(checkpointId, 'before');
}

/**
 * Parse the arguments of `list`.
 *
 * Accepts: `config` — as {@link parseConfig}; `thread_id` omitted lists every
 * thread and `checkpoint_ns` omitted every namespace, as the reference savers
 * do. `options.limit` — an integer from 0 to the page ceiling; `0` asks for
 * nothing, and a negative value is refused rather than read as zero, since it
 * can only be a page size whose computation went wrong. `options.before` — an
 * object naming, at most, a `checkpoint_id`. `options.filter` — metadata
 * equality clauses; an object when given.
 *
 * Returns: the scope every later step of the listing reads instead of the raw
 * config.
 *
 * Throws: `VALIDATION`, config first: as {@link parseConfig}; then
 * `options.<key>` for a key this package does not read, `filter`, `limit`,
 * `before`.
 */
export function parseListScope(config: RunnableConfig, options?: CheckpointListOptions): ListScope {
  const { threadId, checkpointNs, checkpointId, signal } = parseConfig(config);
  if (options !== undefined) {
    assertShape(options, SAVER_LIST_KEYS, 'options');
    if (options.filter !== undefined) assertObjectShape(options.filter, 'filter');
  }
  /**
   * Zero floor: `list` is an iterator a caller drains, so a zero page ends it
   * immediately and visibly. Only a conversation window refuses zero.
   */
  const limit = options?.limit === undefined ? undefined : parseLimit(options.limit, 0);
  return {
    threadId,
    checkpointNs,
    checkpointId,
    before: beforeCheckpointId(options?.before),
    filter: options?.filter as Record<string, FilterValue> | undefined,
    limit,
    signal,
  };
}

/** The arguments of `getDeltaChannelHistory`, their shape checked. */
export interface DeltaHistoryRequest {
  readonly config: RunnableConfig;
  readonly channels: string[];
}

/**
 * Parse the options of `getDeltaChannelHistory` — their shape only. The
 * config's identifiers are parsed by the `getTuple` each hop of the walk calls,
 * and only once a channel is named: an empty `channels` reads nothing, so it
 * refuses nothing either.
 *
 * Accepts: `options` — an object naming exactly `config` and `channels`.
 * `options.config` — shaped as {@link parseConfig} requires. `options.channels`
 * — an array of strings; an empty one is a legitimate request.
 *
 * Returns: the config as given and a copy of the channels.
 *
 * Throws: `VALIDATION` naming `options`, `options.<key>`, `config`,
 * `configurable`, `signal` or `channels`.
 */
export function parseDeltaHistoryRequest(options: DeltaChannelHistoryOptions): DeltaHistoryRequest {
  assertShape(options, DELTA_CHANNEL_HISTORY_KEYS, 'options');
  checkConfigShape(options.config);
  return { config: options.config, channels: parseStringArray(options.channels, 'channels') };
}
