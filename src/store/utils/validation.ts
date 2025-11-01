/**
 * Validation utilities for store operations
 */

import {
  MAX_LOOP_ITERATIONS,
  MAX_TOTAL_ITEMS_IN_MEMORY,
  validateTTLDays as sharedValidateTTL,
} from '../../shared/utils';

const MAX_KEY_LENGTH = 1024;
const MAX_NAMESPACE_DEPTH = 20;
const MAX_VALUE_SIZE = 400 * 1024; // 400KB (DynamoDB item size limit is 400KB)
const MAX_EMBEDDING_DIMENSIONS = 10000;
const MAX_EMBEDDINGS_PER_ITEM = 100;
const MAX_OFFSET = 10000; // Prevent resource exhaustion
const MAX_DEPTH = 100; // Maximum depth for namespace listing
const MAX_BATCH_SIZE = 100; // Maximum operations in a single batch
const MAX_JSONPATH_LENGTH = 500; // Maximum length for JSONPath expressions

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

/**
 * Validate namespace array
 */
export function validateNamespace(namespace: string[]): void {
  if (!Array.isArray(namespace)) {
    throw new ValidationError('Namespace must be an array');
  }

  if (namespace.length === 0) {
    throw new ValidationError('Namespace cannot be empty');
  }

  if (namespace.length > MAX_NAMESPACE_DEPTH) {
    throw new ValidationError(`Namespace depth exceeds maximum of ${MAX_NAMESPACE_DEPTH} levels`);
  }

  for (const part of namespace) {
    if (typeof part !== 'string') {
      throw new ValidationError('Namespace parts must be strings');
    }

    if (part.length === 0) {
      throw new ValidationError('Namespace parts cannot be empty strings');
    }

    if (part.includes('#')) {
      throw new ValidationError('Namespace parts cannot contain "#" character');
    }

    if (part.includes('/')) {
      throw new ValidationError('Namespace parts cannot contain "/" character');
    }
  }
}

/**
 * Validate key string
 */
export function validateKey(key: string): void {
  if (typeof key !== 'string') {
    throw new ValidationError('Key must be a string');
  }

  if (key.length === 0) {
    throw new ValidationError('Key cannot be empty');
  }

  if (key.length > MAX_KEY_LENGTH) {
    throw new ValidationError(`Key exceeds maximum length of ${MAX_KEY_LENGTH} characters`);
  }

  if (key.includes('#')) {
    throw new ValidationError('Key cannot contain "#" character');
  }
}

/**
 * Validate value size
 */
export function validateValue(value: any): void {
  if (value === undefined) {
    throw new ValidationError('Value cannot be undefined');
  }

  const size = JSON.stringify(value).length;
  if (size > MAX_VALUE_SIZE) {
    throw new ValidationError(
      `Value size (${size} bytes) exceeds maximum of ${MAX_VALUE_SIZE} bytes`,
    );
  }
}

/**
 * Validate pagination parameters
 */
export function validatePagination(limit?: number, offset?: number): void {
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit)) {
      throw new ValidationError('Limit must be an integer');
    }

    if (limit < 0) {
      throw new ValidationError('Limit cannot be negative');
    }

    if (limit > 1000) {
      throw new ValidationError('Limit cannot exceed 1000');
    }
  }

  if (offset !== undefined) {
    if (typeof offset !== 'number' || !Number.isInteger(offset)) {
      throw new ValidationError('Offset must be an integer');
    }

    if (offset < 0) {
      throw new ValidationError('Offset cannot be negative');
    }

    if (offset > MAX_OFFSET) {
      throw new ValidationError(`Offset cannot exceed ${MAX_OFFSET}`);
    }
  }
}

/**
 * Validate TTL days (wraps shared validation with a store-specific error type)
 */
export function validateTTL(ttlDays?: number): void {
  try {
    sharedValidateTTL(ttlDays);
  } catch (error) {
    // eslint-disable-next-line no-instanceof/no-instanceof
    throw new ValidationError(error instanceof Error ? error.message : String(error));
  }
}

/**
 * Validate embeddings
 */
export function validateEmbeddings(embeddings?: number[][]): void {
  if (!embeddings) {
    return;
  }

  if (!Array.isArray(embeddings)) {
    throw new ValidationError('Embeddings must be an array');
  }

  if (embeddings.length > MAX_EMBEDDINGS_PER_ITEM) {
    throw new ValidationError(
      `Number of embeddings (${embeddings.length}) exceeds maximum of ${MAX_EMBEDDINGS_PER_ITEM}`,
    );
  }

  for (const embedding of embeddings) {
    if (!Array.isArray(embedding)) {
      throw new ValidationError('Each embedding must be an array of numbers');
    }

    if (embedding.length === 0) {
      throw new ValidationError('Embedding cannot be empty');
    }

    if (embedding.length > MAX_EMBEDDING_DIMENSIONS) {
      throw new ValidationError(
        `Embedding dimensions (${embedding.length}) exceed maximum of ${MAX_EMBEDDING_DIMENSIONS}`,
      );
    }

    for (const value of embedding) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new ValidationError('Embedding values must be finite numbers');
      }
    }
  }
}

/**
 * Validate user ID
 */
export function validateUserId(userId: string): void {
  if (typeof userId !== 'string') {
    throw new ValidationError('User ID must be a string');
  }

  if (userId.length === 0) {
    throw new ValidationError('User ID cannot be empty');
  }

  if (userId.length > 256) {
    throw new ValidationError('User ID exceeds maximum length of 256 characters');
  }
}

/**
 * Validate JSONPath expressions to prevent injection attacks
 */
export function validateJSONPath(paths: string[]): void {
  if (!Array.isArray(paths)) {
    throw new ValidationError('JSONPath index must be an array');
  }

  if (paths.length === 0) {
    return;
  }

  if (paths.length > 50) {
    throw new ValidationError('Too many JSONPath expressions (maximum 50)');
  }

  for (const path of paths) {
    if (typeof path !== 'string') {
      throw new ValidationError('JSONPath expression must be a string');
    }

    if (path.length === 0) {
      throw new ValidationError('JSONPath expression cannot be empty');
    }

    if (path.length > MAX_JSONPATH_LENGTH) {
      throw new ValidationError(
        `JSONPath expression exceeds maximum length of ${MAX_JSONPATH_LENGTH} characters`,
      );
    }

    // Basic safety checks - disallow potentially dangerous patterns
    if (path.includes('__proto__') || path.includes('constructor') || path.includes('prototype')) {
      throw new ValidationError('JSONPath expression contains disallowed patterns');
    }
  }
}

/**
 * Validate maxDepth parameter
 */
export function validateMaxDepth(maxDepth?: number): void {
  if (maxDepth === undefined) {
    return;
  }

  if (typeof maxDepth !== 'number' || !Number.isInteger(maxDepth)) {
    throw new ValidationError('maxDepth must be an integer');
  }

  if (maxDepth < 1) {
    throw new ValidationError('maxDepth must be at least 1');
  }

  if (maxDepth > MAX_DEPTH) {
    throw new ValidationError(`maxDepth cannot exceed ${MAX_DEPTH}`);
  }
}

/**
 * Validate batch operations count
 */
export function validateBatchSize(operationsCount: number): void {
  if (typeof operationsCount !== 'number' || !Number.isInteger(operationsCount)) {
    throw new ValidationError('Operations count must be an integer');
  }

  if (operationsCount < 1) {
    throw new ValidationError('Batch must contain at least one operation');
  }

  if (operationsCount > MAX_BATCH_SIZE) {
    throw new ValidationError(
      `Batch size (${operationsCount}) exceeds maximum of ${MAX_BATCH_SIZE} operations`,
    );
  }
}

/**
 * Export constants for use in other modules
 */
export const ValidationConstants = {
  MAX_LOOP_ITERATIONS,
  MAX_TOTAL_ITEMS_IN_MEMORY,
  MAX_OFFSET,
  MAX_DEPTH,
  MAX_BATCH_SIZE,
} as const;
