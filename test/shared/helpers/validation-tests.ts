/**
 * Reusable validation test patterns
 * Reduces duplication across validation test files
 */

/**
 * Configuration for string field validation tests
 */
export interface StringValidationConfig {
  validateFn: (value: any) => void;
  fieldName: string;
  maxLength?: number;
  allowEmpty?: boolean;
  errorClass?: new (...args: any[]) => Error;
}

/**
 * Run standard validation tests for a string field
 * Tests: type checking, empty string, max length, control characters
 */
export function testStringValidation(config: StringValidationConfig): void {
  const { validateFn, fieldName, maxLength, allowEmpty = false, errorClass = Error } = config;

  it(`should accept valid ${fieldName}`, () => {
    expect(() => validateFn('valid-value-123')).not.toThrow();
  });

  it(`should throw error for non-string ${fieldName}`, () => {
    expect(() => validateFn(123 as any)).toThrow(errorClass);
    expect(() => validateFn(123 as any)).toThrow(`${fieldName} must be a string`);
  });

  if (!allowEmpty) {
    it(`should throw error for empty ${fieldName}`, () => {
      expect(() => validateFn('')).toThrow(errorClass);
      expect(() => validateFn('')).toThrow('cannot be empty');
    });
  } else {
    it(`should accept empty ${fieldName}`, () => {
      expect(() => validateFn('')).not.toThrow();
    });
  }

  if (maxLength) {
    it(`should throw error for ${fieldName} exceeding max length`, () => {
      const longValue = 'a'.repeat(maxLength + 1);
      expect(() => validateFn(longValue)).toThrow(errorClass);
      expect(() => validateFn(longValue)).toThrow('exceeds maximum length');
    });

    it(`should accept ${fieldName} at max length`, () => {
      const maxValue = 'a'.repeat(maxLength);
      expect(() => validateFn(maxValue)).not.toThrow();
    });
  }

  it(`should throw error for ${fieldName} with control characters`, () => {
    expect(() => validateFn('value\x00test')).toThrow(errorClass);
    expect(() => validateFn('value\x00test')).toThrow('cannot contain control characters');
  });
}

/**
 * Configuration for ID field validation tests (no control characters, no separators)
 */
export interface IdValidationConfig extends StringValidationConfig {
  separator?: string;
}

/**
 * Run validation tests for ID fields (thread_id, checkpoint_id, etc.)
 * Tests: all string validations and separator validation
 */
export function testIdValidation(config: IdValidationConfig): void {
  const { validateFn, fieldName, separator = ':::', errorClass = Error } = config;

  // Run standard string validation
  testStringValidation(config);

  // Test separator validation
  it(`should throw error for ${fieldName} containing separator`, () => {
    expect(() => validateFn(`value${separator}test`)).toThrow(errorClass);
    expect(() => validateFn(`value${separator}test`)).toThrow('cannot contain separator');
  });
}

/**
 * Configuration for optional field validation tests
 */
export interface OptionalValidationConfig {
  validateFn: (value: any) => void;
  fieldName: string;
  validValue: any;
  invalidValue: any;
  expectedError: string;
  errorClass?: new (...args: any[]) => Error;
}

/**
 * Run validation tests for optional fields
 * Tests: undefined acceptance, valid value, invalid value
 */
export function testOptionalValidation(config: OptionalValidationConfig): void {
  const {
    validateFn,
    fieldName,
    validValue,
    invalidValue,
    expectedError,
    errorClass = Error,
  } = config;

  it(`should accept undefined ${fieldName}`, () => {
    expect(() => validateFn(undefined)).not.toThrow();
  });

  it(`should accept valid ${fieldName}`, () => {
    expect(() => validateFn(validValue)).not.toThrow();
  });

  it(`should throw error for invalid ${fieldName}`, () => {
    expect(() => validateFn(invalidValue)).toThrow(errorClass);
    expect(() => validateFn(invalidValue)).toThrow(expectedError);
  });
}

/**
 * Configuration for array validation tests
 */
export interface ArrayValidationConfig {
  validateFn: (value: any) => void;
  fieldName: string;
  minLength?: number;
  maxLength?: number;
  validItem: any;
  invalidItem?: any;
  errorClass?: new (...args: any[]) => Error;
}

/**
 * Run validation tests for array fields
 * Tests: type checking, min/max length, item validation
 */
export function testArrayValidation(config: ArrayValidationConfig): void {
  const {
    validateFn,
    fieldName,
    minLength,
    maxLength,
    validItem,
    invalidItem,
    errorClass = Error,
  } = config;

  it(`should accept valid ${fieldName} array`, () => {
    expect(() => validateFn([validItem])).not.toThrow();
  });

  it(`should throw error for non-array ${fieldName}`, () => {
    expect(() => validateFn('not-an-array' as any)).toThrow(errorClass);
    expect(() => validateFn('not-an-array' as any)).toThrow('must be an array');
  });

  if (minLength !== undefined && minLength > 0) {
    it(`should throw error for empty ${fieldName} array`, () => {
      expect(() => validateFn([])).toThrow(errorClass);
      expect(() => validateFn([])).toThrow('cannot be empty');
    });
  }

  if (maxLength) {
    it(`should throw error for ${fieldName} exceeding max length`, () => {
      const longArray = Array(maxLength + 1).fill(validItem);
      expect(() => validateFn(longArray)).toThrow(errorClass);
    });
  }

  if (invalidItem !== undefined) {
    it(`should throw error for invalid item in ${fieldName}`, () => {
      expect(() => validateFn([validItem, invalidItem])).toThrow(errorClass);
    });
  }
}

/**
 * Configuration for numeric validation tests
 */
export interface NumericValidationConfig {
  validateFn: (value: any) => void;
  fieldName: string;
  min?: number;
  max?: number;
  mustBeInteger?: boolean;
  errorClass?: new (...args: any[]) => Error;
}

/**
 * Run validation tests for numeric fields
 * Tests: type checking, integer validation, min/max bounds
 */
export function testNumericValidation(config: NumericValidationConfig): void {
  const { validateFn, fieldName, min, max, mustBeInteger = false, errorClass = Error } = config;

  it(`should accept valid ${fieldName}`, () => {
    const validValue = min !== undefined ? min + 1 : 10;
    expect(() => validateFn(validValue)).not.toThrow();
  });

  it(`should throw error for non-number ${fieldName}`, () => {
    expect(() => validateFn('not-a-number' as any)).toThrow(errorClass);
  });

  if (mustBeInteger) {
    it(`should throw error for non-integer ${fieldName}`, () => {
      expect(() => validateFn(1.5)).toThrow(errorClass);
      expect(() => validateFn(1.5)).toThrow('must be an integer');
    });
  }

  if (min !== undefined) {
    it(`should throw error for ${fieldName} below minimum`, () => {
      expect(() => validateFn(min - 1)).toThrow(errorClass);
    });
  }

  if (max !== undefined) {
    it(`should throw error for ${fieldName} exceeding maximum`, () => {
      expect(() => validateFn(max + 1)).toThrow(errorClass);
    });
  }
}
