import { assertNoSeparator, validateNonEmptyString } from '../../shared/validation/primitives';
import { SORT_KEY_SEPARATOR } from './keys';

/** Validate a thread id is a non-empty, separator-free string. */
export function validateThreadId(threadId: string): void {
  validateNonEmptyString(threadId, 'thread_id');
  assertNoSeparator(threadId, SORT_KEY_SEPARATOR, 'thread_id');
}

/** Validate a checkpoint namespace is separator-free (empty is the root namespace). */
export function validateCheckpointNs(checkpointNs: string): void {
  assertNoSeparator(checkpointNs, SORT_KEY_SEPARATOR, 'checkpoint_ns');
}

/** Validate a checkpoint id is a non-empty, separator-free string. */
export function validateCheckpointId(checkpointId: string): void {
  validateNonEmptyString(checkpointId, 'checkpoint_id');
  assertNoSeparator(checkpointId, SORT_KEY_SEPARATOR, 'checkpoint_id');
}

/** Validate a task id is a non-empty, separator-free string. */
export function validateTaskId(taskId: string): void {
  validateNonEmptyString(taskId, 'taskId');
  assertNoSeparator(taskId, SORT_KEY_SEPARATOR, 'taskId');
}
