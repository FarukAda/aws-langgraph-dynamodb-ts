import { MAX_KEY_SEGMENT_BYTES, MAX_PARTITION_ID_BYTES } from '../../shared/constants';
import {
  assertMaxBytes,
  assertNoControlChars,
  assertNoSeparator,
  validateIdentifier,
} from '../../shared/validation/primitives';
import { SORT_KEY_SEPARATOR } from './keys';

/** Validate a thread id: non-blank, separator- and control-char-free, at most 1024 bytes. */
export function validateThreadId(threadId: string): void {
  validateIdentifier(threadId, SORT_KEY_SEPARATOR, 'thread_id', MAX_PARTITION_ID_BYTES);
}

/**
 * Validate a checkpoint namespace. Unlike the other identifiers an empty value
 * is legal — it is the root namespace — so only the separator, control-character
 * and length rules apply.
 */
export function validateCheckpointNs(checkpointNs: string): void {
  assertNoSeparator(checkpointNs, SORT_KEY_SEPARATOR, 'checkpoint_ns');
  assertNoControlChars(checkpointNs, 'checkpoint_ns');
  assertMaxBytes(checkpointNs, 'checkpoint_ns', MAX_KEY_SEGMENT_BYTES);
}

/** Validate a checkpoint id: non-blank, separator- and control-char-free, at most 256 bytes. */
export function validateCheckpointId(checkpointId: string): void {
  validateIdentifier(checkpointId, SORT_KEY_SEPARATOR, 'checkpoint_id', MAX_KEY_SEGMENT_BYTES);
}

/** Validate a task id: non-blank, separator- and control-char-free, at most 256 bytes. */
export function validateTaskId(taskId: string): void {
  validateIdentifier(taskId, SORT_KEY_SEPARATOR, 'taskId', MAX_KEY_SEGMENT_BYTES);
}
