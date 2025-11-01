import {
  validateUserId,
  validateSessionId,
  validateMessage,
  validateMessages,
  validateTitle,
  validateLimit,
  validateTTLDays,
  HistoryValidationError,
} from '../../../src/history/utils';
import { createMockMessage } from '../../shared/fixtures/test-data';

describe('History Validation', () => {
  describe('validateUserId', () => {
    it('should accept valid user ID', () => {
      expect(() => validateUserId('user-123')).not.toThrow();
    });

    it('should throw error for empty user ID', () => {
      expect(() => validateUserId('')).toThrow(HistoryValidationError);
      expect(() => validateUserId('')).toThrow('User ID cannot be empty');
    });

    it('should throw error for non-string user ID', () => {
      expect(() => validateUserId(123 as any)).toThrow('User ID must be a string');
    });

    it('should throw error for too long user ID', () => {
      const longId = 'a'.repeat(257);
      expect(() => validateUserId(longId)).toThrow('exceeds maximum length');
    });

    it('should throw error for user ID with control characters', () => {
      expect(() => validateUserId('user\x00id')).toThrow('cannot contain control characters');
    });
  });

  describe('validateSessionId', () => {
    it('should accept valid session ID', () => {
      expect(() => validateSessionId('session-123')).not.toThrow();
    });

    it('should throw error for empty session ID', () => {
      expect(() => validateSessionId('')).toThrow('Session ID cannot be empty');
    });

    it('should throw error for non-string session ID', () => {
      expect(() => validateSessionId(123 as any)).toThrow('Session ID must be a string');
    });

    it('should throw error for too long session ID', () => {
      const longId = 'a'.repeat(257);
      expect(() => validateSessionId(longId)).toThrow('exceeds maximum length');
    });

    it('should throw error for session ID with control characters', () => {
      expect(() => validateSessionId('session\x00id')).toThrow('cannot contain control characters');
    });
  });

  describe('validateMessage', () => {
    it('should accept valid message', () => {
      const message = createMockMessage('Test');
      expect(() => validateMessage(message)).not.toThrow();
    });

    it('should throw error for null message', () => {
      expect(() => validateMessage(null as any)).toThrow('cannot be null or undefined');
    });

    it('should throw error for non-object message', () => {
      expect(() => validateMessage('string' as any)).toThrow('must be a BaseMessage object');
    });

    it('should throw error for message without content property', () => {
      const invalidMessage = { type: 'human' } as any;
      expect(() => validateMessage(invalidMessage)).toThrow('must have a content property');
    });
  });

  describe('validateMessages', () => {
    it('should accept valid messages array', () => {
      const messages = [createMockMessage('Test 1'), createMockMessage('Test 2')];
      expect(() => validateMessages(messages)).not.toThrow();
    });

    it('should throw error for non-array', () => {
      expect(() => validateMessages('not-array' as any)).toThrow('Messages must be an array');
    });

    it('should throw error for empty array', () => {
      expect(() => validateMessages([])).toThrow('Messages array cannot be empty');
    });

    it('should throw error for too many messages', () => {
      const manyMessages = Array(101)
        .fill(null)
        .map(() => createMockMessage('Test'));
      expect(() => validateMessages(manyMessages)).toThrow('exceeds maximum of 100');
    });

    it('should throw error with index for invalid message', () => {
      const messages = [createMockMessage('Valid'), null as any];
      expect(() => validateMessages(messages)).toThrow('Invalid message at index 1');
    });
  });

  describe('validateTitle', () => {
    it('should accept valid title', () => {
      expect(() => validateTitle('My Session')).not.toThrow();
    });

    it('should accept undefined title', () => {
      expect(() => validateTitle(undefined)).not.toThrow();
    });

    it('should throw error for non-string title', () => {
      expect(() => validateTitle(123 as any)).toThrow('Title must be a string');
    });

    it('should throw error for too long title', () => {
      const longTitle = 'a'.repeat(201);
      expect(() => validateTitle(longTitle)).toThrow('exceeds maximum length');
    });
  });

  describe('validateLimit', () => {
    it('should accept valid limit', () => {
      expect(() => validateLimit(10)).not.toThrow();
    });

    it('should accept undefined limit', () => {
      expect(() => validateLimit(undefined)).not.toThrow();
    });

    it('should throw error for non-integer limit', () => {
      expect(() => validateLimit(10.5)).toThrow('Limit must be an integer');
    });

    it('should throw error for negative limit', () => {
      expect(() => validateLimit(-1)).toThrow('Limit must be positive');
    });

    it('should throw error for limit exceeding maximum', () => {
      expect(() => validateLimit(1001)).toThrow('Limit cannot exceed 1000');
    });
  });

  describe('validateTTLDays', () => {
    it('should accept undefined', () => {
      expect(() => validateTTLDays(undefined)).not.toThrow();
    });

    it('should accept valid TTL days', () => {
      expect(() => validateTTLDays(7)).not.toThrow();
      expect(() => validateTTLDays(30)).not.toThrow();
    });

    it('should throw HistoryValidationError for invalid TTL days', () => {
      expect(() => validateTTLDays(-1)).toThrow(HistoryValidationError);
      expect(() => validateTTLDays(0)).toThrow(HistoryValidationError);
      expect(() => validateTTLDays(10001)).toThrow(HistoryValidationError);
    });

    it('should wrap error message from shared validation', () => {
      expect(() => validateTTLDays(10.5)).toThrow(HistoryValidationError);
      expect(() => validateTTLDays(10.5)).toThrow('must be an integer');
    });
  });
});
