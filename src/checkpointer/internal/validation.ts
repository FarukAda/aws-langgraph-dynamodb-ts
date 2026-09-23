import type { PendingWrite } from '@langchain/langgraph-checkpoint';

import { MAX_KEY_SEGMENT_BYTES, MAX_PARTITION_ID_BYTES } from '../../shared/constants';
import { validationError } from '../../shared/errors/errors';
import {
  assertMaxBytes,
  assertNoControlChars,
  assertNoSeparator,
  assertWellFormed,
  validateIdentifier,
} from '../../shared/validation/primitives';
import { SORT_KEY_SEPARATOR } from './keys';

/**
 * Validate a thread id as the partition key it becomes.
 *
 * Accepts: `threadId` — non-blank, free of the sort-key separator and of
 * control characters, well-formed UTF-16, at most
 * {@link MAX_PARTITION_ID_BYTES}.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `thread_id`.
 */
export function validateThreadId(threadId: string): void {
  validateIdentifier(threadId, SORT_KEY_SEPARATOR, 'thread_id', MAX_PARTITION_ID_BYTES);
}

/**
 * Validate a checkpoint namespace.
 *
 * Accepts: `checkpointNs` — unlike every other identifier an empty value is
 * legal, because it *is* the root namespace. The non-blank rule is therefore
 * dropped and every other rule `validateIdentifier` applies is repeated here
 * rather than skipped: the namespace is a segment of both the sort key and the
 * offloaded object's key, so a lone surrogate or a control character in it is
 * as damaging as anywhere else.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `checkpoint_ns`, including for a value that is
 * not a string — that case used to reach `Buffer.byteLength` and surface as a
 * raw Node `TypeError` out of a public method.
 */
export function validateCheckpointNs(checkpointNs: string): void {
  assertMaxBytes(checkpointNs, 'checkpoint_ns', MAX_KEY_SEGMENT_BYTES);
  assertNoSeparator(checkpointNs, SORT_KEY_SEPARATOR, 'checkpoint_ns');
  assertNoControlChars(checkpointNs, 'checkpoint_ns');
  assertWellFormed(checkpointNs, 'checkpoint_ns');
}

/**
 * Validate a checkpoint id as the sort-key segment it becomes.
 *
 * Accepts: `checkpointId` — non-blank, free of the separator and of control
 * characters, at most {@link MAX_KEY_SEGMENT_BYTES}. `field` — defaults to
 * `checkpoint_id`; `configurable.ts` passes `thread_ts` when the value being
 * checked was read from that field instead, so the error names the field the
 * caller actually set rather than the one the value happened to end up in.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `field`.
 */
export function validateCheckpointId(checkpointId: string, field = 'checkpoint_id'): void {
  validateIdentifier(checkpointId, SORT_KEY_SEPARATOR, field, MAX_KEY_SEGMENT_BYTES);
}

/**
 * Validate a task id as the sort-key segment it becomes.
 *
 * Accepts: `taskId` — non-blank, free of the separator and of control
 * characters, at most {@link MAX_KEY_SEGMENT_BYTES}. LangGraph's own task ids
 * are UUIDs; the rule is stated for whatever else a caller passes.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `taskId`.
 */
export function validateTaskId(taskId: string): void {
  validateIdentifier(taskId, SORT_KEY_SEPARATOR, 'taskId', MAX_KEY_SEGMENT_BYTES);
}

/**
 * Validate a pending-write channel name.
 *
 * Accepts: `channel` — the trailing segment of the WRITE sort key, so the same
 * rules as every other segment. LangGraph's own channel names never contain the
 * reserved separator.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `channel`.
 */
export function validateChannel(channel: string): void {
  validateIdentifier(channel, SORT_KEY_SEPARATOR, 'channel', MAX_KEY_SEGMENT_BYTES);
}

/**
 * Refuse a `writes` argument that cannot be read as the tuples it is typed to
 * hold.
 *
 * Accepts: `writes` — declared `PendingWrite[]`
 * (`@langchain/langgraph-checkpoint`: `[channel: string, value: unknown]`) for
 * a caller whose types hold. Only what that type rules out is checked here: a
 * non-array `writes`, and an entry that is not itself an array. An entry's
 * first element — whether it is a string — is left to {@link validateChannel},
 * which the write-item builder already calls on every entry once this check
 * has let it be read; duplicating that rule here would either repeat it or,
 * for an entry whose element is present but wrongly typed, report it under
 * this function's field name instead of `validateChannel`'s more specific
 * one. The value, and any element beyond the first two, are unconstrained:
 * upstream's type places no rule on them.
 *
 * Returns: nothing; validity is the absence of a throw.
 *
 * Throws: `VALIDATION` naming `writes`, with the offending index for an
 * entry that is not an array — before either reaches `writes.length` or a
 * destructuring `for...of` over an entry, both of which raise a raw
 * `TypeError` rather than this package's own error.
 */
export function validateWrites(writes: PendingWrite[]): void {
  if (!Array.isArray(writes)) {
    throw validationError('writes must be an array', 'writes');
  }
  writes.forEach((entry, index) => {
    if (!Array.isArray(entry)) {
      throw validationError(`writes[${index}] must be a [channel, value] tuple`, 'writes');
    }
  });
}
