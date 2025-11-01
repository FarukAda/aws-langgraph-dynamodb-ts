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
  });

  describe('validateSessionId', () => {
    testStringValidation({
      validateFn: validateSessionId,
      fieldName: 'Session ID',
      maxLength: 256,
      allowEmpty: false,
      errorClass: HistoryValidationError,
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
});
