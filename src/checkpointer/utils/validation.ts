/**
 * Validation utilities for checkpointer operations
 */

import { validateTTLDays as sharedValidateTTL } from '../../shared/utils';

const MAX_THREAD_ID_LENGTH = 256;
const MAX_CHECKPOINT_ID_LENGTH = 256;
const MAX_CHECKPOINT_NS_LENGTH = 256;
const MAX_TASK_ID_LENGTH = 256;
const MAX_CHANNEL_LENGTH = 256;
const MAX_WRITES_PER_BATCH = 1000;
const MAX_LIST_LIMIT = 1000;
const MAX_DELETE_BATCH_SIZE = 100; // Maximum checkpoints to delete at once
const SEPARATOR = ':::';

export class CheckpointerValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CheckpointerValidationError';
  }
}

/**
 * Validate thread ID
 */
export function validateThreadId(threadId: any): void {
  if (typeof threadId !== 'string') {
    throw new CheckpointerValidationError('thread_id must be a string');
  }

  if (threadId.length === 0) {
    throw new CheckpointerValidationError('thread_id cannot be empty');
  }

  if (threadId.length > MAX_THREAD_ID_LENGTH) {
    throw new CheckpointerValidationError(
      `thread_id exceeds maximum length of ${MAX_THREAD_ID_LENGTH} characters`,
    );
  }

  // Prevent separator injection
  if (threadId.includes(SEPARATOR)) {
    throw new CheckpointerValidationError(`thread_id cannot contain separator "${SEPARATOR}"`);
  }

  // Prevent control characters and null bytes
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(threadId)) {
    throw new CheckpointerValidationError('thread_id cannot contain control characters');
  }
}

/**
 * Validate checkpoint ID
 */
export function validateCheckpointId(checkpointId: any, required: boolean = false): void {
  if (checkpointId === undefined) {
    if (required) {
      throw new CheckpointerValidationError('checkpoint_id is required');
    }
    return;
  }

  if (typeof checkpointId !== 'string') {
    throw new CheckpointerValidationError('checkpoint_id must be a string');
  }

  if (checkpointId.length === 0) {
    throw new CheckpointerValidationError('checkpoint_id cannot be empty');
  }

  if (checkpointId.length > MAX_CHECKPOINT_ID_LENGTH) {
    throw new CheckpointerValidationError(
      `checkpoint_id exceeds maximum length of ${MAX_CHECKPOINT_ID_LENGTH} characters`,
    );
  }

  // Prevent separator injection
  if (checkpointId.includes(SEPARATOR)) {
    throw new CheckpointerValidationError(`checkpoint_id cannot contain separator "${SEPARATOR}"`);
  }

  // Prevent control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(checkpointId)) {
    throw new CheckpointerValidationError('checkpoint_id cannot contain control characters');
  }
}

/**
 * Validate checkpoint namespace
 */
export function validateCheckpointNs(checkpointNs: any): void {
  if (checkpointNs === undefined || checkpointNs === '') {
    return; // Empty namespace is allowed
  }

  if (typeof checkpointNs !== 'string') {
    throw new CheckpointerValidationError('checkpoint_ns must be a string');
  }

  if (checkpointNs.length > MAX_CHECKPOINT_NS_LENGTH) {
    throw new CheckpointerValidationError(
      `checkpoint_ns exceeds maximum length of ${MAX_CHECKPOINT_NS_LENGTH} characters`,
    );
  }

  // Prevent separator injection
  if (checkpointNs.includes(SEPARATOR)) {
    throw new CheckpointerValidationError(`checkpoint_ns cannot contain separator "${SEPARATOR}"`);
  }

  // Prevent control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(checkpointNs)) {
    throw new CheckpointerValidationError('checkpoint_ns cannot contain control characters');
  }
}

/**
 * Validate task ID
 */
export function validateTaskId(taskId: any): void {
  if (typeof taskId !== 'string') {
    throw new CheckpointerValidationError('task_id must be a string');
  }

  if (taskId.length === 0) {
    throw new CheckpointerValidationError('task_id cannot be empty');
  }

  if (taskId.length > MAX_TASK_ID_LENGTH) {
    throw new CheckpointerValidationError(
      `task_id exceeds maximum length of ${MAX_TASK_ID_LENGTH} characters`,
    );
  }

  // Prevent separator injection
  if (taskId.includes(SEPARATOR)) {
    throw new CheckpointerValidationError(`task_id cannot contain separator "${SEPARATOR}"`);
  }
}

/**
 * Validate channel name
 */
export function validateChannel(channel: any): void {
  if (typeof channel !== 'string') {
    throw new CheckpointerValidationError('channel must be a string');
  }

  if (channel.length === 0) {
    throw new CheckpointerValidationError('channel cannot be empty');
  }

  if (channel.length > MAX_CHANNEL_LENGTH) {
    throw new CheckpointerValidationError(
      `channel exceeds maximum length of ${MAX_CHANNEL_LENGTH} characters`,
    );
  }
}

/**
 * Validate writes array length
 */
export function validateWritesCount(writesCount: any): void {
  if (typeof writesCount !== 'number' || !Number.isInteger(writesCount)) {
    throw new CheckpointerValidationError('Writes count must be an integer');
  }

  if (writesCount < 0) {
    throw new CheckpointerValidationError('Writes count cannot be negative');
  }

  if (writesCount > MAX_WRITES_PER_BATCH) {
    throw new CheckpointerValidationError(
      `Writes count (${writesCount}) exceeds maximum of ${MAX_WRITES_PER_BATCH}`,
    );
  }
}

/**
 * Validate list limit parameter
 */
export function validateListLimit(limit: any): void {
  if (limit === undefined) {
    return;
  }

  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new CheckpointerValidationError('Limit must be an integer');
  }

  if (limit <= 0) {
    throw new CheckpointerValidationError('Limit must be positive');
  }

  if (limit > MAX_LIST_LIMIT) {
    throw new CheckpointerValidationError(`Limit cannot exceed ${MAX_LIST_LIMIT}`);
  }
}

/**
 * Validate TTL days (wraps shared validation with a checkpointer-specific error type)
 */
export function validateTTLDays(ttlDays: number | undefined): void {
  try {
    sharedValidateTTL(ttlDays);
  } catch (error) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    throw new CheckpointerValidationError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Export constants for use in other modules
 */
export const CheckpointerValidationConstants = {
  MAX_DELETE_BATCH_SIZE,
  MAX_WRITES_PER_BATCH,
  MAX_LIST_LIMIT,
  SEPARATOR,
} as const;
