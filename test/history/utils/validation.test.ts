import {
  validateUserId,
  validateSessionId,
  validateMessage,
  validateMessages,
  validateMessagesSize,
  validateTitle,
  validateLimit,
  validateTTLDays,
  HistoryValidationError,
} from '../../../src/history/utils';
import { createMockMessage } from '../../shared/fixtures/test-data';
import {
  testStringValidation,
  testOptionalValidation,
  testArrayValidation,
  testNumericValidation,
} from '../../shared/helpers/validation-tests';

describe('History Validation', () => {
  describe('validateUserId', () => {
    testStringValidation({
      validateFn: validateUserId,
      fieldName: 'User ID',
      maxLength: 256,
      allowEmpty: false,
      errorClass: HistoryValidationError,
    });

    it('rejects "#" to prevent composite-sort-key collision', () => {
      expect(() => validateUserId('user#admin')).toThrow(HistoryValidationError);
    });
  });

  describe('validateSessionId', () => {
    testStringValidation({
      validateFn: validateSessionId,
      fieldName: 'Session ID',
      maxLength: 256,
      allowEmpty: false,
      errorClass: HistoryValidationError,
    });

    it('rejects "#" to prevent sort-key injection', () => {
      expect(() => validateSessionId('session#msg#000001')).toThrow(HistoryValidationError);
      expect(() => validateSessionId('session#')).toThrow(HistoryValidationError);
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
    const validMessage = createMockMessage('Test');

    testArrayValidation({
      validateFn: validateMessages,
      fieldName: 'Messages',
      minLength: 1,
      maxLength: 100,
      validItem: validMessage,
      invalidItem: null,
      errorClass: HistoryValidationError,
    });

    it('should throw error with index for invalid message', () => {
      const messages = [createMockMessage('Valid'), null as any];
      expect(() => validateMessages(messages)).toThrow('Invalid message at index 1');
    });
  });

  describe('validateTitle', () => {
    testOptionalValidation({
      validateFn: validateTitle,
      fieldName: 'Title',
      validValue: 'My Session',
      invalidValue: 'a'.repeat(201),
      expectedError: 'exceeds maximum length',
      errorClass: HistoryValidationError,
    });

    it('should throw error for non-string title', () => {
      expect(() => validateTitle(123 as any)).toThrow('Title must be a string');
    });
  });

  describe('validateLimit', () => {
    testOptionalValidation({
      validateFn: validateLimit,
      fieldName: 'Limit',
      validValue: 10,
      invalidValue: 1001,
      expectedError: 'cannot exceed 1000',
      errorClass: HistoryValidationError,
    });

    testNumericValidation({
      validateFn: validateLimit,
      fieldName: 'Limit',
      min: 0,
      max: 1000,
      mustBeInteger: true,
      errorClass: HistoryValidationError,
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
  describe('validateMessagesSize', () => {
    it('should accept messages within 4MB limit', () => {
      const messages = Array(10)
        .fill(null)
        .map(() => createMockMessage('Short message'));
      expect(() => validateMessagesSize(messages)).not.toThrow();
    });

    it('should throw HistoryValidationError for messages exceeding 4MB', () => {
      // Each message ~50KB content + 500 bytes overhead = ~50.5KB
      // 100 messages × ~50.5KB = ~5MB > 4MB limit
      const largeContent = 'x'.repeat(50 * 1024);
      const messages = Array(100)
        .fill(null)
        .map(() => createMockMessage(largeContent));
      expect(() => validateMessagesSize(messages)).toThrow(HistoryValidationError);
      expect(() => validateMessagesSize(messages)).toThrow('exceeds DynamoDB transaction limit');
    });
  });
});
