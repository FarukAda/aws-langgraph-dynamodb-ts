import {
  validateNamespace,
  validateKey,
  validateValue,
  validatePagination,
  validateTTL,
  validateEmbeddings,
  validateUserId,
  validateJSONPath,
  validateMaxDepth,
  validateBatchSize,
  ValidationError,
  ValidationConstants,
} from '../../../src/store/utils';

describe('store validation', () => {
  describe('validateNamespace', () => {
    it('should accept valid namespaces', () => {
      expect(() => validateNamespace(['user', 'session'])).not.toThrow();
      expect(() => validateNamespace(['a'])).not.toThrow();
      expect(() => validateNamespace(['level1', 'level2', 'level3'])).not.toThrow();
    });

    it('should reject non-array values', () => {
      expect(() => validateNamespace('not-array' as any)).toThrow('Namespace must be an array');
    });

    it('should reject empty arrays', () => {
      expect(() => validateNamespace([])).toThrow('Namespace cannot be empty');
    });

    it('should reject namespaces exceeding max depth', () => {
      const deepNamespace = Array(21).fill('level');
      expect(() => validateNamespace(deepNamespace)).toThrow('Namespace depth exceeds maximum');
    });

    it('should accept namespace at max depth', () => {
      const maxNamespace = Array(20).fill('level');
      expect(() => validateNamespace(maxNamespace)).not.toThrow();
    });

    it('should reject non-string parts', () => {
      expect(() => validateNamespace([123 as any])).toThrow('Namespace parts must be strings');
      expect(() => validateNamespace(['valid', null as any])).toThrow(
        'Namespace parts must be strings',
      );
    });

    it('should reject empty string parts', () => {
      expect(() => validateNamespace([''])).toThrow('Namespace parts cannot be empty strings');
      expect(() => validateNamespace(['valid', ''])).toThrow(
        'Namespace parts cannot be empty strings',
      );
    });

    it('should reject parts containing #', () => {
      expect(() => validateNamespace(['part#with#hash'])).toThrow(
        'Namespace parts cannot contain "#" character',
      );
    });

    it('should reject parts containing /', () => {
      expect(() => validateNamespace(['part/with/slash'])).toThrow(
        'Namespace parts cannot contain "/" character',
      );
    });
  });

  describe('validateKey', () => {
    it('should accept valid keys', () => {
      expect(() => validateKey('key-123')).not.toThrow();
      expect(() => validateKey('a')).not.toThrow();
      expect(() => validateKey('key_with_underscores')).not.toThrow();
    });

    it('should reject non-string values', () => {
      expect(() => validateKey(123 as any)).toThrow('Key must be a string');
    });

    it('should reject empty string', () => {
      expect(() => validateKey('')).toThrow('Key cannot be empty');
    });

    it('should reject keys exceeding max length', () => {
      const longKey = 'a'.repeat(1025);
      expect(() => validateKey(longKey)).toThrow('Key exceeds maximum length');
    });

    it('should accept key at max length', () => {
      const maxKey = 'a'.repeat(1024);
      expect(() => validateKey(maxKey)).not.toThrow();
    });

    it('should reject keys containing #', () => {
      expect(() => validateKey('key#with#hash')).toThrow('Key cannot contain "#" character');
    });
  });

  describe('validateValue', () => {
    it('should accept valid values', () => {
      expect(() => validateValue({ data: 'test' })).not.toThrow();
      expect(() => validateValue('string value')).not.toThrow();
      expect(() => validateValue(123)).not.toThrow();
      expect(() => validateValue(null)).not.toThrow();
      expect(() => validateValue([1, 2, 3])).not.toThrow();
    });

    it('should reject undefined', () => {
      expect(() => validateValue(undefined)).toThrow('Value cannot be undefined');
    });

    it('should reject values exceeding max size', () => {
      const largeValue = { data: 'a'.repeat(400 * 1024) };
      expect(() => validateValue(largeValue)).toThrow('Value size');
    });

    it('should accept value at max size boundary', () => {
      const maxValue = { data: 'a'.repeat(400 * 1024 - 20) }; // Subtract for JSON overhead
      expect(() => validateValue(maxValue)).not.toThrow();
    });
  });

  describe('validatePagination', () => {
    it('should accept valid pagination parameters', () => {
      expect(() => validatePagination(10, 0)).not.toThrow();
      expect(() => validatePagination(100, 50)).not.toThrow();
      expect(() => validatePagination(1000, 1000)).not.toThrow();
    });

    it('should accept undefined parameters', () => {
      expect(() => validatePagination(undefined, undefined)).not.toThrow();
      expect(() => validatePagination(10, undefined)).not.toThrow();
      expect(() => validatePagination(undefined, 10)).not.toThrow();
    });

    it('should reject non-integer limit', () => {
      expect(() => validatePagination(1.5, 0)).toThrow('Limit must be an integer');
    });

    it('should reject negative limit', () => {
      expect(() => validatePagination(-1, 0)).toThrow('Limit cannot be negative');
    });

    it('should reject limit exceeding max', () => {
      expect(() => validatePagination(1001, 0)).toThrow('Limit cannot exceed 1000');
    });

    it('should reject non-integer offset', () => {
      expect(() => validatePagination(10, 1.5)).toThrow('Offset must be an integer');
    });

    it('should reject negative offset', () => {
      expect(() => validatePagination(10, -1)).toThrow('Offset cannot be negative');
    });

    it('should reject offset exceeding max', () => {
      expect(() => validatePagination(10, 10001)).toThrow('Offset cannot exceed 10000');
    });
  });

  describe('validateTTL', () => {
    it('should accept valid TTL', () => {
      expect(() => validateTTL(1)).not.toThrow();
      expect(() => validateTTL(30)).not.toThrow();
      expect(() => validateTTL(365)).not.toThrow();
    });

    it('should accept undefined', () => {
      expect(() => validateTTL(undefined)).not.toThrow();
    });

    it('should reject invalid values and throw ValidationError', () => {
      expect(() => validateTTL(0)).toThrow(ValidationError);
      expect(() => validateTTL(-1)).toThrow(ValidationError);
      expect(() => validateTTL(1.5)).toThrow(ValidationError);
    });
  });

  describe('validateEmbeddings', () => {
    it('should accept valid embeddings', () => {
      expect(() => validateEmbeddings([[1, 2, 3]])).not.toThrow();
      expect(() =>
        validateEmbeddings([
          [0.1, 0.2, 0.3],
          [0.4, 0.5, 0.6],
        ]),
      ).not.toThrow();
    });

    it('should accept undefined', () => {
      expect(() => validateEmbeddings(undefined)).not.toThrow();
    });

    it('should reject non-array embeddings', () => {
      expect(() => validateEmbeddings('not-array' as any)).toThrow('Embeddings must be an array');
    });

    it('should reject too many embeddings', () => {
      const manyEmbeddings = Array(101)
        .fill(null)
        .map(() => [1, 2, 3]);
      expect(() => validateEmbeddings(manyEmbeddings)).toThrow('Number of embeddings');
    });

    it('should reject non-array embedding', () => {
      expect(() => validateEmbeddings(['not-array' as any])).toThrow(
        'Each embedding must be an array of numbers',
      );
    });

    it('should reject empty embedding', () => {
      expect(() => validateEmbeddings([[]])).toThrow('Embedding cannot be empty');
    });

    it('should reject embedding with too many dimensions', () => {
      const largeEmbedding = Array(10001).fill(1);
      expect(() => validateEmbeddings([largeEmbedding])).toThrow('Embedding dimensions');
    });

    it('should reject embedding with non-number values', () => {
      expect(() => validateEmbeddings([['a' as any, 'b' as any]])).toThrow(
        'Embedding values must be finite numbers',
      );
    });

    it('should reject embedding with non-finite values', () => {
      expect(() => validateEmbeddings([[Infinity]])).toThrow(
        'Embedding values must be finite numbers',
      );
      expect(() => validateEmbeddings([[NaN]])).toThrow('Embedding values must be finite numbers');
    });
  });

  describe('validateUserId', () => {
    it('should accept valid user IDs', () => {
      expect(() => validateUserId('user-123')).not.toThrow();
      expect(() => validateUserId('a')).not.toThrow();
    });

    it('should reject non-string values', () => {
      expect(() => validateUserId(123 as any)).toThrow('User ID must be a string');
    });

    it('should reject empty string', () => {
      expect(() => validateUserId('')).toThrow('User ID cannot be empty');
    });

    it('should reject user IDs exceeding max length', () => {
      const longId = 'a'.repeat(257);
      expect(() => validateUserId(longId)).toThrow('User ID exceeds maximum length');
    });

    it('should accept user ID at max length', () => {
      const maxId = 'a'.repeat(256);
      expect(() => validateUserId(maxId)).not.toThrow();
    });
  });

  describe('validateJSONPath', () => {
    it('should accept valid JSONPath expressions', () => {
      expect(() => validateJSONPath(['$.field'])).not.toThrow();
      expect(() => validateJSONPath(['$.user.name', '$.user.email'])).not.toThrow();
    });

    it('should accept empty array', () => {
      expect(() => validateJSONPath([])).not.toThrow();
    });

    it('should reject non-array', () => {
      expect(() => validateJSONPath('not-array' as any)).toThrow('JSONPath index must be an array');
    });

    it('should reject too many expressions', () => {
      const manyPaths = Array(51).fill('$.field');
      expect(() => validateJSONPath(manyPaths)).toThrow('Too many JSONPath expressions');
    });

    it('should reject non-string expressions', () => {
      expect(() => validateJSONPath([123 as any])).toThrow('JSONPath expression must be a string');
    });

    it('should reject empty string expression', () => {
      expect(() => validateJSONPath([''])).toThrow('JSONPath expression cannot be empty');
    });

    it('should reject expressions exceeding max length', () => {
      const longPath = 'a'.repeat(501);
      expect(() => validateJSONPath([longPath])).toThrow(
        'JSONPath expression exceeds maximum length',
      );
    });

    it('should reject expressions with __proto__', () => {
      expect(() => validateJSONPath(['$.__proto__.field'])).toThrow(
        'JSONPath expression contains disallowed patterns',
      );
    });

    it('should reject expressions with constructor', () => {
      expect(() => validateJSONPath(['$.constructor.field'])).toThrow(
        'JSONPath expression contains disallowed patterns',
      );
    });

    it('should reject expressions with prototype', () => {
      expect(() => validateJSONPath(['$.prototype.field'])).toThrow(
        'JSONPath expression contains disallowed patterns',
      );
    });
  });

  describe('validateMaxDepth', () => {
    it('should accept valid max depth', () => {
      expect(() => validateMaxDepth(1)).not.toThrow();
      expect(() => validateMaxDepth(10)).not.toThrow();
      expect(() => validateMaxDepth(100)).not.toThrow();
    });

    it('should accept undefined', () => {
      expect(() => validateMaxDepth(undefined)).not.toThrow();
    });

    it('should reject non-integer', () => {
      expect(() => validateMaxDepth(1.5)).toThrow('maxDepth must be an integer');
    });

    it('should reject zero', () => {
      expect(() => validateMaxDepth(0)).toThrow('maxDepth must be at least 1');
    });

    it('should reject negative values', () => {
      expect(() => validateMaxDepth(-1)).toThrow('maxDepth must be at least 1');
    });

    it('should reject values exceeding max', () => {
      expect(() => validateMaxDepth(101)).toThrow('maxDepth cannot exceed 100');
    });
  });

  describe('validateBatchSize', () => {
    it('should accept valid batch sizes', () => {
      expect(() => validateBatchSize(1)).not.toThrow();
      expect(() => validateBatchSize(50)).not.toThrow();
      expect(() => validateBatchSize(100)).not.toThrow();
    });

    it('should reject non-integer', () => {
      expect(() => validateBatchSize(1.5)).toThrow('Operations count must be an integer');
    });

    it('should reject zero', () => {
      expect(() => validateBatchSize(0)).toThrow('Batch must contain at least one operation');
    });

    it('should reject negative values', () => {
      expect(() => validateBatchSize(-1)).toThrow('Batch must contain at least one operation');
    });

    it('should reject sizes exceeding max', () => {
      expect(() => validateBatchSize(101)).toThrow('Batch size');
    });
  });

  describe('ValidationError', () => {
    it('should create error with correct name', () => {
      const error = new ValidationError('test message');
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe('ValidationError');
      expect(error.message).toBe('test message');
    });
  });

  describe('ValidationConstants', () => {
    it('should export expected constants', () => {
      expect(ValidationConstants.MAX_LOOP_ITERATIONS).toBe(100);
      expect(ValidationConstants.MAX_TOTAL_ITEMS_IN_MEMORY).toBe(10000);
      expect(ValidationConstants.MAX_OFFSET).toBe(10000);
      expect(ValidationConstants.MAX_DEPTH).toBe(100);
      expect(ValidationConstants.MAX_BATCH_SIZE).toBe(100);
    });
  });
});

// Test re-exported utilities from the index
describe('store utils index re-exports', () => {
  it('should re-export retry and result utilities from index', () => {
    // These imports are from the index file that re-exports from other modules
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { withRetry, withDynamoDBRetry, Ok, Err } = require('../../../src/store/utils');
    expect(withRetry).toBeDefined();
    expect(withDynamoDBRetry).toBeDefined();
    expect(Ok).toBeDefined();
    expect(Err).toBeDefined();
    expect(typeof withRetry).toBe('function');
    expect(typeof withDynamoDBRetry).toBe('function');
    expect(typeof Ok).toBe('function');
    expect(typeof Err).toBe('function');
  });
});
