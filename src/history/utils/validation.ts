/**
 * Validation utilities for chat message history operations
 */

import { BaseMessage } from '@langchain/core/messages';

import { validateTTLDays as sharedValidateTTL } from '../../shared/utils';

const MAX_USER_ID_LENGTH = 256;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_TITLE_LENGTH = 200;
// 99 so that N message Puts + 1 metadata Update still fit in a single
// 100-item DynamoDB TransactWrite (used for atomic index allocation).
const MAX_MESSAGES_PER_BATCH = 99;
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

  // Reject '#' to prevent collisions with the composite sort-key separator used for
  // message items ("${sessionId}#msg#<idx>"). Defense in depth — userId is the PK today.
  if (userId.includes('#')) {
    throw new HistoryValidationError('User ID cannot contain "#" character');
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

  // Reject '#' to prevent injection into the composite sort-key format
  // "${sessionId}#msg#<idx>". A sessionId containing "#msg#" could otherwise let
  // getMessages/clear cross into another of the same user's sessions.
  if (sessionId.includes('#')) {
    throw new HistoryValidationError('Session ID cannot contain "#" character');
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

/** DynamoDB transactWrite limit: 4MB total across all items */
const MAX_TRANSACTION_SIZE_BYTES = 4 * 1024 * 1024;
/** Estimated per-item overhead: PK, SK, itemType, messageIndex, ttl, DynamoDB encoding */
const PER_ITEM_OVERHEAD_BYTES = 500;

/**
 * Validate total estimated size of messages for DynamoDB transaction limits.
 * Prevents runtime `TransactionCanceledException` due to 4MB size exceeded.
 *
 * @param messages - Array of BaseMessage objects to validate
 * @throws HistoryValidationError if estimated size exceeds 4MB
 */
export function validateMessagesSize(messages: BaseMessage[]): void {
  let totalSize = 0;
  for (const message of messages) {
    // Measure the WHOLE message, not just `content`. additional_kwargs, tool_calls,
    // response_metadata, etc. are stored alongside and can be larger than content.
    // Use `toJSON` when present (BaseMessage subclasses expose it) so we serialize
    // the same shape that mapChatMessagesToStoredMessages produces.
    const serializable =
      typeof (message as unknown as { toJSON?: () => unknown }).toJSON === 'function'
        ? (message as unknown as { toJSON: () => unknown }).toJSON()
        : message;
    const size = new TextEncoder().encode(JSON.stringify(serializable)).byteLength;
    totalSize += size + PER_ITEM_OVERHEAD_BYTES;
  }
  if (totalSize > MAX_TRANSACTION_SIZE_BYTES) {
    throw new HistoryValidationError(
      `Estimated batch size (~${Math.round(totalSize / 1024)}KB) exceeds DynamoDB transaction limit of 4MB`,
    );
  }
}
