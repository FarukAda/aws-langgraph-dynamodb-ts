/**
 * Validation utilities for chat message history operations
 */

import { BaseMessage } from '@langchain/core/messages';

import { validateTTLDays as sharedValidateTTL } from '../../shared/utils';

const MAX_USER_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 200;
const MAX_MESSAGES_PER_BATCH = 100;
const MAX_LIST_LIMIT = 1000;

/**
 * Custom error class for validation errors in chat message history
 */
export class HistoryValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HistoryValidationError';
  }
}

/**
 * Validate user ID
 *
 * @param userId - User identifier to validate
 * @throws HistoryValidationError if validation fails
 */
export function validateUserId(userId: any): void {
  if (typeof userId !== 'string') {
    throw new HistoryValidationError('User ID must be a string');
  }

  if (userId.length === 0) {
    throw new HistoryValidationError('User ID cannot be empty');
  }

  if (userId.length > MAX_USER_ID_LENGTH) {
    throw new HistoryValidationError(
      `User ID exceeds maximum length of ${MAX_USER_ID_LENGTH} characters`,
    );
  }

  // Prevent control characters and null bytes
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(userId)) {
    throw new HistoryValidationError('User ID cannot contain control characters');
  }
}

/**
 * Validate session ID
 *
 * @param sessionId - Session identifier to validate
 * @throws HistoryValidationError if validation fails
 */
export function validateSessionId(sessionId: any): void {
  if (typeof sessionId !== 'string') {
    throw new HistoryValidationError('Session ID must be a string');
  }

  if (sessionId.length === 0) {
    throw new HistoryValidationError('Session ID cannot be empty');
  }

  if (sessionId.length > MAX_SESSION_ID_LENGTH) {
    throw new HistoryValidationError(
      `Session ID exceeds maximum length of ${MAX_SESSION_ID_LENGTH} characters`,
    );
  }

  // Prevent control characters
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1F\x7F]/.test(sessionId)) {
    throw new HistoryValidationError('Session ID cannot contain control characters');
  }
}

/**
 * Validate a single message
 *
 * @param message - BaseMessage to validate
 * @throws HistoryValidationError if validation fails
 */
export function validateMessage(message: BaseMessage): void {
  if (!message) {
    throw new HistoryValidationError('Message cannot be null or undefined');
  }

  if (typeof message !== 'object') {
    throw new HistoryValidationError('Message must be a BaseMessage object');
  }

  // Check for required BaseMessage properties
  if (!message.content && message.content !== '') {
    throw new HistoryValidationError('Message must have a content property');
  }
}

/**
 * Validate messages array
 *
 * @param messages - Array of BaseMessage objects to validate
 * @throws HistoryValidationError if validation fails
 */
export function validateMessages(messages: BaseMessage[]): void {
  if (!Array.isArray(messages)) {
    throw new HistoryValidationError('Messages must be an array');
  }

  if (messages.length === 0) {
    throw new HistoryValidationError('Messages array cannot be empty');
  }

  if (messages.length > MAX_MESSAGES_PER_BATCH) {
    throw new HistoryValidationError(
      `Messages batch size (${messages.length}) exceeds maximum of ${MAX_MESSAGES_PER_BATCH}`,
    );
  }

  for (let i = 0; i < messages.length; i++) {
    try {
      validateMessage(messages[i]);
    } catch (error) {
      throw new HistoryValidationError(
        // eslint-disable-next-line no-instanceof/no-instanceof
        `Invalid message at index ${i}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

/**
 * Validate title
 *
 * @param title - Optional title string to validate
 * @throws HistoryValidationError if validation fails
 */
export function validateTitle(title: any): void {
  if (title === undefined) {
    return;
  }

  if (typeof title !== 'string') {
    throw new HistoryValidationError('Title must be a string');
  }

  if (title.length > MAX_TITLE_LENGTH) {
    throw new HistoryValidationError(
      `Title exceeds maximum length of ${MAX_TITLE_LENGTH} characters`,
    );
  }
}

/**
 * Validate list limit parameter
 *
 * @param limit - Optional maximum number of items to return
 * @throws HistoryValidationError if validation fails
 */
export function validateLimit(limit: any): void {
  if (limit === undefined) {
    return;
  }

  if (typeof limit !== 'number' || !Number.isInteger(limit)) {
    throw new HistoryValidationError('Limit must be an integer');
  }

  if (limit <= 0) {
    throw new HistoryValidationError('Limit must be positive');
  }

  if (limit > MAX_LIST_LIMIT) {
    throw new HistoryValidationError(`Limit cannot exceed ${MAX_LIST_LIMIT}`);
  }
}

/**
 * Validate TTL days (wraps shared validation with a history-specific error type)
 *
 * @param ttlDays - Optional TTL in days
 * @throws HistoryValidationError if validation fails
 */
export function validateTTLDays(ttlDays: number | undefined): void {
  try {
    sharedValidateTTL(ttlDays);
  } catch (error) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    throw new HistoryValidationError(error instanceof Error ? error.message : String(error));
  }
}
