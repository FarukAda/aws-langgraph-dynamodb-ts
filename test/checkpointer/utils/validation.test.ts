import {
  validateThreadId,
  validateCheckpointId,
  validateCheckpointNs,
  validateTaskId,
  validateChannel,
  validateWritesCount,
  validateListLimit,
  validateTTLDays,
  CheckpointerValidationError,
  CheckpointerValidationConstants,
} from '../../../src/checkpointer/utils';

describe('checkpointer validation', () => {
  describe('validateThreadId', () => {
    it('should accept valid thread IDs', () => {
      expect(() => validateThreadId('thread-123')).not.toThrow();
      expect(() => validateThreadId('a')).not.toThrow();
      expect(() => validateThreadId('thread_id_with_underscores')).not.toThrow();
      expect(() => validateThreadId('thread-with-dashes')).not.toThrow();
    });

    it('should reject non-string values', () => {
      expect(() => validateThreadId(123 as any)).toThrow('thread_id must be a string');
      expect(() => validateThreadId(null as any)).toThrow('thread_id must be a string');
      expect(() => validateThreadId(undefined as any)).toThrow('thread_id must be a string');
    });

    it('should reject empty string', () => {
      expect(() => validateThreadId('')).toThrow('thread_id cannot be empty');
    });

    it('should reject thread IDs exceeding max length', () => {
      const longId = 'a'.repeat(257);
      expect(() => validateThreadId(longId)).toThrow('thread_id exceeds maximum length');
    });

    it('should accept thread ID at max length', () => {
      const maxId = 'a'.repeat(256);
      expect(() => validateThreadId(maxId)).not.toThrow();
    });

    it('should reject thread IDs containing separator', () => {
      expect(() => validateThreadId('thread:::id')).toThrow('thread_id cannot contain separator');
    });

    it('should reject thread IDs with control characters', () => {
      expect(() => validateThreadId('thread\x00id')).toThrow(
        'thread_id cannot contain control characters',
      );
      expect(() => validateThreadId('thread\nid')).toThrow(
        'thread_id cannot contain control characters',
      );
      expect(() => validateThreadId('thread\tid')).toThrow(
        'thread_id cannot contain control characters',
      );
    });
  });

  describe('validateCheckpointId', () => {
    it('should accept valid checkpoint IDs', () => {
      expect(() => validateCheckpointId('checkpoint-123', true)).not.toThrow();
      expect(() => validateCheckpointId('a', true)).not.toThrow();
    });

    it('should accept undefined when not required', () => {
      expect(() => validateCheckpointId(undefined, false)).not.toThrow();
    });

    it('should reject undefined when required', () => {
      expect(() => validateCheckpointId(undefined, true)).toThrow('checkpoint_id is required');
    });

    it('should reject non-string values', () => {
      expect(() => validateCheckpointId(123 as any, true)).toThrow(
        'checkpoint_id must be a string',
      );
    });

    it('should reject empty string', () => {
      expect(() => validateCheckpointId('', true)).toThrow('checkpoint_id cannot be empty');
    });

    it('should reject checkpoint IDs exceeding max length', () => {
      const longId = 'a'.repeat(257);
      expect(() => validateCheckpointId(longId, true)).toThrow(
        'checkpoint_id exceeds maximum length',
      );
    });

    it('should reject checkpoint IDs containing separator', () => {
      expect(() => validateCheckpointId('checkpoint:::id', true)).toThrow(
        'checkpoint_id cannot contain separator',
      );
    });

    it('should reject checkpoint IDs with control characters', () => {
      expect(() => validateCheckpointId('checkpoint\x00id', true)).toThrow(
        'checkpoint_id cannot contain control characters',
      );
    });
  });

  describe('validateCheckpointNs', () => {
    it('should accept valid namespaces', () => {
      expect(() => validateCheckpointNs('namespace-1')).not.toThrow();
      expect(() => validateCheckpointNs('ns')).not.toThrow();
    });

    it('should accept undefined', () => {
      expect(() => validateCheckpointNs(undefined)).not.toThrow();
    });

    it('should accept empty string', () => {
      expect(() => validateCheckpointNs('')).not.toThrow();
    });

    it('should reject non-string values', () => {
      expect(() => validateCheckpointNs(123 as any)).toThrow('checkpoint_ns must be a string');
    });

    it('should reject namespace exceeding max length', () => {
      const longNs = 'a'.repeat(257);
      expect(() => validateCheckpointNs(longNs)).toThrow('checkpoint_ns exceeds maximum length');
    });

    it('should reject namespace containing separator', () => {
      expect(() => validateCheckpointNs('ns:::name')).toThrow(
        'checkpoint_ns cannot contain separator',
      );
    });

    it('should reject namespace with control characters', () => {
      expect(() => validateCheckpointNs('ns\x00name')).toThrow(
        'checkpoint_ns cannot contain control characters',
      );
    });
  });

  describe('validateTaskId', () => {
    it('should accept valid task IDs', () => {
      expect(() => validateTaskId('task-123')).not.toThrow();
      expect(() => validateTaskId('a')).not.toThrow();
    });

    it('should reject non-string values', () => {
      expect(() => validateTaskId(123 as any)).toThrow('task_id must be a string');
    });

    it('should reject empty string', () => {
      expect(() => validateTaskId('')).toThrow('task_id cannot be empty');
    });

    it('should reject task IDs exceeding max length', () => {
      const longId = 'a'.repeat(257);
      expect(() => validateTaskId(longId)).toThrow('task_id exceeds maximum length');
    });

    it('should reject task IDs containing separator', () => {
      expect(() => validateTaskId('task:::id')).toThrow('task_id cannot contain separator');
    });
  });

  describe('validateChannel', () => {
    it('should accept valid channel names', () => {
      expect(() => validateChannel('messages')).not.toThrow();
      expect(() => validateChannel('a')).not.toThrow();
      expect(() => validateChannel('channel-with-dashes')).not.toThrow();
    });

    it('should reject non-string values', () => {
      expect(() => validateChannel(123 as any)).toThrow('channel must be a string');
    });

    it('should reject empty string', () => {
      expect(() => validateChannel('')).toThrow('channel cannot be empty');
    });

    it('should reject channel names exceeding max length', () => {
      const longChannel = 'a'.repeat(257);
      expect(() => validateChannel(longChannel)).toThrow('channel exceeds maximum length');
    });

    it('should accept channel at max length', () => {
      const maxChannel = 'a'.repeat(256);
      expect(() => validateChannel(maxChannel)).not.toThrow();
    });
  });

  describe('validateWritesCount', () => {
    it('should accept valid counts', () => {
      expect(() => validateWritesCount(0)).not.toThrow();
      expect(() => validateWritesCount(1)).not.toThrow();
      expect(() => validateWritesCount(100)).not.toThrow();
      expect(() => validateWritesCount(1000)).not.toThrow();
    });

    it('should reject non-integer values', () => {
      expect(() => validateWritesCount(1.5)).toThrow('Writes count must be an integer');
      expect(() => validateWritesCount(NaN)).toThrow('Writes count must be an integer');
    });

    it('should reject non-number types', () => {
      expect(() => validateWritesCount('10' as any)).toThrow('Writes count must be an integer');
    });

    it('should reject negative values', () => {
      expect(() => validateWritesCount(-1)).toThrow('Writes count cannot be negative');
    });

    it('should reject counts exceeding max', () => {
      expect(() => validateWritesCount(1001)).toThrow('Writes count');
      expect(() => validateWritesCount(2000)).toThrow('Writes count');
    });
  });

  describe('validateListLimit', () => {
    it('should accept valid limits', () => {
      expect(() => validateListLimit(1)).not.toThrow();
      expect(() => validateListLimit(100)).not.toThrow();
      expect(() => validateListLimit(1000)).not.toThrow();
    });

    it('should accept undefined', () => {
      expect(() => validateListLimit(undefined)).not.toThrow();
    });

    it('should reject non-integer values', () => {
      expect(() => validateListLimit(1.5)).toThrow('Limit must be an integer');
    });

    it('should reject zero and negative values', () => {
      expect(() => validateListLimit(0)).toThrow('Limit must be positive');
      expect(() => validateListLimit(-1)).toThrow('Limit must be positive');
    });

    it('should reject limits exceeding max', () => {
      expect(() => validateListLimit(1001)).toThrow('Limit cannot exceed 1000');
    });
  });

  describe('validateTTLDays', () => {
    it('should accept valid TTL days', () => {
      expect(() => validateTTLDays(1)).not.toThrow();
      expect(() => validateTTLDays(30)).not.toThrow();
      expect(() => validateTTLDays(365)).not.toThrow();
    });

    it('should accept undefined', () => {
      expect(() => validateTTLDays(undefined)).not.toThrow();
    });

    it('should reject invalid values and throw CheckpointerValidationError', () => {
      expect(() => validateTTLDays(0)).toThrow(CheckpointerValidationError);
      expect(() => validateTTLDays(-1)).toThrow(CheckpointerValidationError);
      expect(() => validateTTLDays(1.5)).toThrow(CheckpointerValidationError);
    });
  });

  describe('CheckpointerValidationError', () => {
    it('should create error with correct name', () => {
      const error = new CheckpointerValidationError('test message');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('CheckpointerValidationError');
      expect(error.message).toBe('test message');
    });
  });

  describe('CheckpointerValidationConstants', () => {
    it('should export expected constants', () => {
      expect(CheckpointerValidationConstants.MAX_DELETE_BATCH_SIZE).toBe(100);
      expect(CheckpointerValidationConstants.MAX_WRITES_PER_BATCH).toBe(1000);
      expect(CheckpointerValidationConstants.MAX_LIST_LIMIT).toBe(1000);
      expect(CheckpointerValidationConstants.SEPARATOR).toBe(':::');
    });
  });
});

// Test re-exported utilities from index
describe('checkpointer utils index re-exports', () => {
  it('should re-export retry utilities from index', () => {
    // These imports are from the index file which re-exports from shared
    const { withRetry, withDynamoDBRetry } = require('../../../src/checkpointer/utils');
    expect(withRetry).toBeDefined();
    expect(withDynamoDBRetry).toBeDefined();
    expect(typeof withRetry).toBe('function');
    expect(typeof withDynamoDBRetry).toBe('function');
  });
});
