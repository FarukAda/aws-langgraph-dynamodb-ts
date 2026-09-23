import { MAX_PAGE_LIMIT } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  parseListOperation,
  parseNamespace,
  parseNamespacePrefix,
  parseStoreAddress,
} from '../../../../src/store/internal/parse';

const refusal = (field: string) =>
  expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field } });

describe('parseNamespace', () => {
  it('accepts a non-empty, separator-free namespace', () => {
    expect(() => parseNamespace(['users', 'u1'])).not.toThrow();
  });

  it('throws on an empty namespace array', () => {
    expect(() => parseNamespace([])).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws on an empty namespace element', () => {
    expect(() => parseNamespace(['users', ''])).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws when an element contains the reserved separator', () => {
    expect(() => parseNamespace(['users', 'a#b'])).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws when an element contains a control character (M7)', () => {
    expect(() => parseNamespace(['users', 'a\u001b[31m'])).toThrow(/control characters/);
  });

  it("accepts '.' and a 'langgraph' root, which only the put() method refuses", () => {
    expect(() => parseNamespace(['users', 'a.b'])).not.toThrow();
    expect(() => parseNamespace(['langgraph'])).not.toThrow();
  });

  it('names the field its caller gives', () => {
    expect(() => parseNamespace([], 'namespacePrefix')).toThrow(refusal('namespacePrefix'));
    expect(() => parseNamespace(['a#b'], 'namespacePrefix')).toThrow(
      refusal('namespacePrefix element'),
    );
  });
});

describe('parseNamespacePrefix', () => {
  it('accepts an empty path, a "*" label without any exemption, and "."', () => {
    expect(() => parseNamespacePrefix([], 'prefix')).not.toThrow();
    expect(() => parseNamespacePrefix(['*', 'a.b', '*'], 'prefix')).not.toThrow();
  });

  it('names the argument for a non-array and its element for a bad label', () => {
    expect(() => parseNamespacePrefix('x', 'suffix')).toThrow(refusal('suffix'));
    expect(() => parseNamespacePrefix(['a', 1 as never], 'suffix')).toThrow(
      refusal('suffix element'),
    );
    expect(() => parseNamespacePrefix(['a#b'], 'suffix')).toThrow(refusal('suffix element'));
  });
});

/** `parseStoreAddress`'s key rules, isolated with a throwaway namespace. */
describe('parseStoreAddress key rules', () => {
  it('accepts a non-empty, separator-free key', () => {
    expect(() => parseStoreAddress(['ns'], 'k1')).not.toThrow();
  });

  it('throws on an empty key', () => {
    expect(() => parseStoreAddress(['ns'], '')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws when the key contains the reserved separator', () => {
    expect(() => parseStoreAddress(['ns'], 'b#c')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });

  it('throws when the key contains a control character (M7)', () => {
    expect(() => parseStoreAddress(['ns'], 'b\u0000c')).toThrow(/control characters/);
  });
});

describe('parseStoreAddress (STORE-14)', () => {
  it('bounds each segment at 256 bytes', () => {
    expect(() => parseStoreAddress(['users', 'u1'], 'k'.repeat(256))).not.toThrow();
    expect(() => parseStoreAddress(['users', 'u1'], 'k'.repeat(257))).toThrow(
      'key must be at most 256 bytes',
    );
    expect(() => parseNamespace(['users', 'e'.repeat(257)])).toThrow(
      'namespace element must be at most 256 bytes',
    );
  });

  it('bounds the composed sort key at the 1024 bytes DynamoDB allows', () => {
    const rest = ['a'.repeat(256), 'b'.repeat(256), 'c'.repeat(256)];
    expect(() => parseStoreAddress(['root', ...rest], 'k'.repeat(253))).not.toThrow();
    expect(() => parseStoreAddress(['root', ...rest], 'k'.repeat(254))).toThrow(
      /1025-byte sort key.*1024 bytes/,
    );
  });

  it('rejects a whitespace-only element or key', () => {
    expect(() => parseNamespace(['users', '  '])).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
    expect(() => parseStoreAddress(['ns'], ' ')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION }),
    );
  });
});

describe('parseListOperation paging', () => {
  const paging = (offset: number, limit: number) => parseListOperation({ offset, limit });

  it('accepts non-negative integers', () => {
    expect(() => paging(0, 10)).not.toThrow();
  });

  it('throws on a negative offset', () => {
    expect(() => paging(-1, 10)).toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION }));
  });

  it('throws on a non-integer limit', () => {
    expect(() => paging(0, 1.5)).toThrow(expect.objectContaining({ code: ErrorCode.VALIDATION }));
  });

  /**
   * The store was the only `limit` already bounded below and, like every other,
   * bounded nowhere above: `store.search({ limit: 1e12 })` resolved.
   */
  it('throws on a limit above the page ceiling and names it', () => {
    expect(() => paging(0, MAX_PAGE_LIMIT)).not.toThrow();
    expect(() => paging(0, MAX_PAGE_LIMIT + 1)).toThrow(refusal('limit'));
    expect(() => paging(0, 1e12)).toThrow(`limit must be <= ${MAX_PAGE_LIMIT}`);
  });

  /**
   * `offset` carries no ceiling of its own: it says where a page starts rather
   * than how much one holds, and `maxScanItems` already bounds what it can make
   * a read walk.
   */
  it('leaves a large offset alone', () => {
    expect(() => paging(1e12, 10)).not.toThrow();
  });
});
