import {
  assertNoControlChars,
  assertNoSeparator,
  validateIdentifier,
} from '../../shared/validation/primitives';
import { SORT_KEY_SEPARATOR } from './keys';

/** Validate a thread id is a non-empty, separator- and control-char-free string. */
export function validateThreadId(threadId: string): void {
  validateIdentifier(threadId, SORT_KEY_SEPARATOR, 'thread_id');
}

/**
 * Validate a checkpoint namespace. Unlike the other identifiers an empty value
 * is legal — it is the root namespace — so only the separator and
 * control-character rules apply.
 */
export function validateCheckpointNs(checkpointNs: string): void {
  assertNoSeparator(checkpointNs, SORT_KEY_SEPARATOR, 'checkpoint_ns');
  assertNoControlChars(checkpointNs, 'checkpoint_ns');
}

/** Validate a checkpoint id is a non-empty, separator- and control-char-free string. */
export function validateCheckpointId(checkpointId: string): void {
  validateIdentifier(checkpointId, SORT_KEY_SEPARATOR, 'checkpoint_id');
}

/** Validate a task id is a non-empty, separator- and control-char-free string. */
export function validateTaskId(taskId: string): void {
  validateIdentifier(taskId, SORT_KEY_SEPARATOR, 'taskId');
}
