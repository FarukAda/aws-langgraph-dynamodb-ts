import type { Operation } from '@langchain/langgraph-checkpoint';
import { expectTypeOf } from 'expect-type';

import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { MAX_PAGE_LIMIT } from '../../../../src/shared/validation/primitives';
import {
  type Namespace,
  type NamespacePrefix,
  parseListNamespacesOptions,
  parseListOperation,
  parseNamespace,
  parseNamespacePrefix,
  parseOperation,
  parseOperations,
  type ParsedDelete,
  type ParsedGet,
  type ParsedMatchCondition,
  type ParsedOperation,
  parsePutArguments,
  parseSearch,
  parseStoreAddress,
  type StoreAddress,
} from '../../../../src/store/internal/parse';

/** Matches the `VALIDATION` refusal naming `field`. */
const refusal = (field: string) =>
  expect.objectContaining({
    code: ErrorCode.VALIDATION,
    context: expect.objectContaining({ field }),
  });

const ROOT = parseNamespacePrefix([], 'namespacePrefix');

describe('namespaces', () => {
  it('parses a non-empty namespace into a copy', () => {
    const given = ['users', 'u1'];
    const namespace = parseNamespace(given);
    given.push('x');
    expect(namespace).toEqual(['users', 'u1']);
  });

  it('refuses an empty or non-array namespace, and names a bad label as an element', () => {
    expect(() => parseNamespace([])).toThrow('namespace must be a non-empty array');
    expect(() => parseNamespace('users')).toThrow(refusal('namespace'));
    expect(() => parseNamespace([], 'namespacePrefix')).toThrow(refusal('namespacePrefix'));
    expect(() => parseNamespace(['a.b', 'a#b'])).toThrow(refusal('namespace element'));
  });

  it('accepts an empty prefix, and names its field', () => {
    expect(parseNamespacePrefix([], 'namespacePrefix')).toEqual([]);
    expect(() => parseNamespacePrefix('x', 'namespacePrefix')).toThrow(
      'namespacePrefix must be an array of labels',
    );
    expect(() => parseNamespacePrefix(['ok', ''], 'prefix')).toThrow(refusal('prefix element'));
  });

  it('checks every label, holes included', () => {
    const sparse = ['a'];
    sparse.length = 2;
    expect(() => parseNamespacePrefix(sparse, 'namespacePrefix')).toThrow(
      refusal('namespacePrefix element'),
    );
  });

  it('parses a prefix into a copy', () => {
    const given = ['a'];
    const prefix = parseNamespacePrefix(given, 'namespacePrefix');
    given.push('x');
    expect(prefix).toEqual(['a']);
  });
});

describe('parseStoreAddress', () => {
  it('parses the namespace, then the key, then the composed sort key', () => {
    expect(parseStoreAddress(['users', 'u1'], 'k')).toEqual({
      namespace: ['users', 'u1'],
      key: 'k',
    });
    expect(() => parseStoreAddress([], 'a#b')).toThrow(refusal('namespace'));
    expect(() => parseStoreAddress(['ns'], 'a#b')).toThrow(refusal('key'));
    expect(() => parseStoreAddress(['ns'], 7)).toThrow(refusal('key'));
    const labels = Array.from({ length: 5 }, () => 'l'.repeat(256));
    expect(() => parseStoreAddress(labels, 'k'.repeat(256))).toThrow(refusal('sortKey'));
  });
});

describe('parsePutArguments', () => {
  it('parses what put() stores', () => {
    expect(parsePutArguments(['ns'], 'k', { a: 1 }, ['a'])).toEqual({
      kind: 'put',
      address: { namespace: ['ns'], key: 'k' },
      value: { a: 1 },
      index: ['a'],
    });
    expect(parsePutArguments(['ns'], 'k', { a: 1 }, false).index).toBe(false);
    expect(parsePutArguments(['ns'], 'k', { a: 1 }, undefined).index).toBeUndefined();
  });

  it("parses an index into a copy of the caller's array", () => {
    const given = ['a'];
    const { index } = parsePutArguments(['ns'], 'k', {}, given);
    given.push('x');
    expect(index).toEqual(['a']);
  });

  it('adds the rules upstream put() applies, and refuses a null value', () => {
    expect(() => parsePutArguments(['a.b'], 'k', {}, undefined)).toThrow(
      refusal('namespace element'),
    );
    expect(() => parsePutArguments(['langgraph'], 'k', {}, undefined)).toThrow(
      refusal('namespace'),
    );
    expect(() => parsePutArguments(['ns'], 'k', null as never, undefined)).toThrow(
      'value must be an object; delete() removes an item',
    );
    expect(() => parsePutArguments(['ns'], 'k', 'x' as never, undefined)).toThrow(refusal('value'));
    expect(() => parsePutArguments(['ns'], 'k', {}, [1] as never)).toThrow(refusal('index'));
  });
});

describe('parseSearch', () => {
  it('applies the defaults a search reads with', () => {
    expect(parseSearch(ROOT, {})).toEqual({
      kind: 'search',
      namespacePrefix: [],
      filter: undefined,
      query: undefined,
      offset: 0,
      limit: 10,
    });
    expect(parseSearch(ROOT, { filter: { a: 1 }, query: 'q', offset: 2, limit: 0 })).toMatchObject({
      filter: { a: 1 },
      query: 'q',
      offset: 2,
      limit: 0,
    });
  });

  it('refuses filter, query, offset and limit in that order', () => {
    expect(() => parseSearch(ROOT, { filter: 'x' as never, query: 1 as never })).toThrow(
      refusal('filter'),
    );
    expect(() => parseSearch(ROOT, { query: 1 as never, offset: -1 })).toThrow(
      'query must be a string',
    );
    expect(() => parseSearch(ROOT, { offset: -1, limit: -1 })).toThrow(refusal('offset'));
    expect(() => parseSearch(ROOT, { offset: null as never })).toThrow(refusal('offset'));
    expect(() => parseSearch(ROOT, { limit: MAX_PAGE_LIMIT + 1 })).toThrow(refusal('limit'));
  });
});

describe('parseListOperation', () => {
  it('parses paging, depth and match conditions', () => {
    expect(
      parseListOperation({
        limit: 5,
        offset: 1,
        maxDepth: 2,
        matchConditions: [{ matchType: 'suffix', path: ['*', 'b'] }],
      }),
    ).toEqual({
      kind: 'list',
      limit: 5,
      offset: 1,
      maxDepth: 2,
      matchConditions: [{ matchType: 'suffix', path: ['*', 'b'] }],
    });
    expect(parseListOperation({ limit: 0, offset: 0 })).toMatchObject({
      maxDepth: undefined,
      matchConditions: undefined,
    });
  });

  it("parses a match condition's path into a copy of the caller's array", () => {
    const path = ['a'];
    const { matchConditions } = parseListOperation({
      offset: 0,
      limit: 0,
      matchConditions: [{ matchType: 'prefix', path }],
    });
    path.push('x');
    expect(matchConditions).toEqual([{ matchType: 'prefix', path: ['a'] }]);
  });

  it('refuses offset, limit, depth and conditions in that order', () => {
    expect(() => parseListOperation({ offset: -1, limit: -1 })).toThrow(refusal('offset'));
    expect(() => parseListOperation({ offset: 0, limit: -1, maxDepth: 0 })).toThrow(
      refusal('limit'),
    );
    expect(() => parseListOperation({ offset: 0, limit: 0, maxDepth: 0 })).toThrow(
      refusal('maxDepth'),
    );
    expect(() =>
      parseListOperation({ offset: 0, limit: 0, matchConditions: 'x' as never }),
    ).toThrow('matchConditions must be an array');
    expect(() =>
      parseListOperation({ offset: 0, limit: 0, matchConditions: [null as never] }),
    ).toThrow(refusal('matchConditions'));
    for (const matchType of ['infix', 3]) {
      expect(() =>
        parseListOperation({
          offset: 0,
          limit: 0,
          matchConditions: [{ matchType: matchType as never, path: [] }],
        }),
      ).toThrow(/matchType must be "prefix" or "suffix"/);
    }
    expect(() =>
      parseListOperation({
        offset: 0,
        limit: 0,
        matchConditions: [{ matchType: 'prefix', path: ['a#b'] }],
      }),
    ).toThrow(refusal('prefix element'));
  });
});

describe('parseListNamespacesOptions', () => {
  it('builds the list operation the options describe, with the default page', () => {
    expect(parseListNamespacesOptions({})).toEqual({
      kind: 'list',
      matchConditions: undefined,
      maxDepth: undefined,
      limit: 100,
      offset: 0,
    });
    expect(
      parseListNamespacesOptions({ prefix: ['a'], suffix: ['z'], limit: 3, offset: 1 }),
    ).toMatchObject({
      matchConditions: [
        { matchType: 'prefix', path: ['a'] },
        { matchType: 'suffix', path: ['z'] },
      ],
      limit: 3,
      offset: 1,
    });
  });

  it('refuses a key it does not read before any value', () => {
    expect(() => parseListNamespacesOptions({ bogus: 1, limit: -1 } as never)).toThrow(
      refusal('options.bogus'),
    );
  });
});

describe('parseOperation', () => {
  it('tells the five operations apart once, by their shape', () => {
    const kinds = (
      [
        { namespacePrefix: ['a'] },
        { namespace: ['a'], key: 'k', value: { v: 1 } },
        { namespace: ['a'], key: 'k', value: null },
        { namespace: ['a'], key: 'k' },
        { limit: 1, offset: 0 },
      ] as Operation[]
    ).map((operation) => parseOperation(operation).kind);
    expect(kinds).toEqual(['search', 'put', 'delete', 'get', 'list']);
  });

  it("checks a delete's index too, as a put with a null value always was", () => {
    expect(() =>
      parseOperation({ namespace: ['a'], key: 'k', value: null, index: [1] as never }),
    ).toThrow(refusal('index'));
    expect(() => parseOperation({ namespace: ['a'], key: 'k', value: undefined as never })).toThrow(
      refusal('value'),
    );
  });

  it('refuses an operation that is not an object', () => {
    for (const operation of [null, 'x', []]) {
      expect(() => parseOperation(operation as never)).toThrow(
        'every operation in operations must be an object',
      );
    }
  });
});

describe('parseOperations', () => {
  it('parses every operation before any runs', () => {
    expect(parseOperations([{ namespace: ['a'], key: 'k' }])).toHaveLength(1);
    expect(() => parseOperations('x' as never)).toThrow('operations must be an array');
    expect(() =>
      parseOperations([
        { namespace: ['a'], key: 'k' },
        { namespace: [], key: 'k' },
      ]),
    ).toThrow(refusal('namespace'));
  });
});

describe('the parsed types', () => {
  it('cannot be forged from plain arrays and objects', () => {
    expectTypeOf<string[]>().not.toMatchTypeOf<Namespace>();
    expectTypeOf<string[]>().not.toMatchTypeOf<NamespacePrefix>();
    expectTypeOf<{ namespace: Namespace; key: string }>().not.toMatchTypeOf<StoreAddress>();
    expectTypeOf<Namespace>().toMatchTypeOf<string[]>();
    expectTypeOf(parseOperation({ namespace: ['a'], key: 'k' })).toEqualTypeOf<ParsedOperation>();
  });

  it("narrows the union to each kind's own interface", () => {
    const get = parseOperation({ namespace: ['a'], key: 'k' });
    expect(get.kind).toBe('get');
    if (get.kind === 'get') expectTypeOf(get).toEqualTypeOf<ParsedGet>();

    const deleted = parseOperation({ namespace: ['a'], key: 'k', value: null });
    expect(deleted.kind).toBe('delete');
    if (deleted.kind === 'delete') expectTypeOf(deleted).toEqualTypeOf<ParsedDelete>();

    expectTypeOf(parseListOperation({ offset: 0, limit: 0 }).matchConditions).toEqualTypeOf<
      ParsedMatchCondition[] | undefined
    >();
  });
});
