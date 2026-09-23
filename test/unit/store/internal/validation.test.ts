import { MAX_PAGE_LIMIT } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  validateKey,
  validateNamespace,
  validateNamespaceLabels,
  validatePaging,
  validateStoreKey,
} from '../../../../src/store/internal/validation';

const refusal = (field: string) =>
  expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field } });

describe('validateNamespace', () => {
  it('accepts a non-empty, separator-free namespace', () => {
    expect(() => validateNamespace(['users', 'u1'])).not.toThrow();
  });

  it('throws on an empty namespace array', () => {
    expect(() => validateNamespace([])).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws on an empty namespace element', () => {
    expect(() => validateNamespace(['users', ''])).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws when an element contains the reserved separator', () => {
    expect(() => validateNamespace(['users', 'a#b'])).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws when an element contains a control character (M7)', () => {
    expect(() => validateNamespace(['users', 'a\u001b[31m'])).toThrow(/control characters/);
  });

  it("accepts '.' and a 'langgraph' root, which only the put() method refuses", () => {
    expect(() => validateNamespace(['users', 'a.b'])).not.toThrow();
    expect(() => validateNamespace(['langgraph'])).not.toThrow();
  });

  it('names the field its caller gives', () => {
    expect(() => validateNamespace([], 'namespacePrefix')).toThrow(refusal('namespacePrefix'));
    expect(() => validateNamespace(['a#b'], 'namespacePrefix')).toThrow(
      refusal('namespacePrefix element'),
    );
  });
});

describe('validateNamespaceLabels', () => {
  it('accepts an empty path, a "*" label without any exemption, and "."', () => {
    expect(() => validateNamespaceLabels([], 'prefix')).not.toThrow();
    expect(() => validateNamespaceLabels(['*', 'a.b', '*'], 'prefix')).not.toThrow();
  });

  it('names the argument for a non-array and its element for a bad label', () => {
    expect(() => validateNamespaceLabels('x' as never, 'suffix')).toThrow(refusal('suffix'));
    expect(() => validateNamespaceLabels(['a', 1 as never], 'suffix')).toThrow(
      refusal('suffix element'),
    );
    expect(() => validateNamespaceLabels(['a#b'], 'suffix')).toThrow(refusal('suffix element'));
  });
});

describe('validateKey', () => {
  it('accepts a non-empty, separator-free key', () => {
    expect(() => validateKey('k1')).not.toThrow();
  });

  it('throws on an empty key', () => {
    expect(() => validateKey('')).toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION }));
  });

  it('throws when the key contains the reserved separator', () => {
    expect(() => validateKey('b#c')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws when the key contains a control character (M7)', () => {
    expect(() => validateKey('b\u0000c')).toThrow(/control characters/);
  });
});

describe('validateStoreKey (STORE-14)', () => {
  it('bounds each segment at 256 bytes', () => {
    expect(() => validateStoreKey(['users', 'u1'], 'k'.repeat(256))).not.toThrow();
    expect(() => validateStoreKey(['users', 'u1'], 'k'.repeat(257))).toThrow(
      'key must be at most 256 bytes',
    );
    expect(() => validateNamespace(['users', 'e'.repeat(257)])).toThrow(
      'namespace element must be at most 256 bytes',
    );
  });

  it('bounds the composed sort key at the 1024 bytes DynamoDB allows', () => {
    const rest = ['a'.repeat(256), 'b'.repeat(256), 'c'.repeat(256)];
    expect(() => validateStoreKey(['root', ...rest], 'k'.repeat(253))).not.toThrow();
    expect(() => validateStoreKey(['root', ...rest], 'k'.repeat(254))).toThrow(
      /1025-byte sort key.*1024 bytes/,
    );
  });

  it('rejects a whitespace-only element or key', () => {
    expect(() => validateNamespace(['users', '  '])).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
    expect(() => validateKey(' ')).toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION }));
  });
});

describe('validatePaging', () => {
  it('accepts non-negative integers', () => {
    expect(() => validatePaging(0, 10)).not.toThrow();
  });

  it('throws on a negative offset', () => {
    expect(() => validatePaging(-1, 10)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws on a non-integer limit', () => {
    expect(() => validatePaging(0, 1.5)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  /**
   * The store was the only `limit` already bounded below and, like every other,
   * bounded nowhere above: `store.search({ limit: 1e12 })` resolved.
   */
  it('throws on a limit above the page ceiling and names it', () => {
    expect(() => validatePaging(0, MAX_PAGE_LIMIT)).not.toThrow();
    expect(() => validatePaging(0, MAX_PAGE_LIMIT + 1)).toThrow(refusal('limit'));
    expect(() => validatePaging(0, 1e12)).toThrow(`limit must be <= ${MAX_PAGE_LIMIT}`);
  });

  /**
   * `offset` carries no ceiling of its own: it says where a page starts rather
   * than how much one holds, and `maxScanItems` already bounds what it can make
   * a read walk.
   */
  it('leaves a large offset alone', () => {
    expect(() => validatePaging(1e12, 10)).not.toThrow();
  });
});
