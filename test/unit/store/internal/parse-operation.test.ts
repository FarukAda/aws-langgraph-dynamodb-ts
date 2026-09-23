import type { Operation } from '@langchain/langgraph-checkpoint';

import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  parseListOperation,
  parseNamespacePrefix,
  parseOperation,
  parseOperations,
} from '../../../../src/store/internal/parse';

const refusal = (field: string) =>
  expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field } });

const listing = (matchConditions: unknown) => ({ matchConditions, limit: 10, offset: 0 }) as never;

const put = (value: unknown, index?: unknown) =>
  ({ namespace: ['ns'], key: 'k', value, index }) as never;

describe('parseNamespacePrefix (as a search prefix)', () => {
  it('accepts an empty prefix, a "." and a "langgraph" root; refuses a bad key segment', () => {
    expect(() => parseNamespacePrefix([], 'namespacePrefix')).not.toThrow();
    expect(() => parseNamespacePrefix(['langgraph', 'a.b'], 'namespacePrefix')).not.toThrow();
    expect(() => parseNamespacePrefix('x', 'namespacePrefix')).toThrow(refusal('namespacePrefix'));
    expect(() => parseNamespacePrefix(['a', ''], 'namespacePrefix')).toThrow(
      refusal('namespacePrefix element'),
    );
  });
});

describe('parseOperation (search shape)', () => {
  it('checks the prefix, then filter and query, then paging, leaving absent paging alone', () => {
    expect(() => parseOperation({ namespacePrefix: ['a'] })).not.toThrow();
    expect(() => parseOperation({ namespacePrefix: ['a#b'], filter: 'x' as never })).toThrow(
      refusal('namespacePrefix element'),
    );
    expect(() => parseOperation({ namespacePrefix: [], filter: [] as never })).toThrow(
      refusal('filter'),
    );
    expect(() => parseOperation({ namespacePrefix: [], query: 1 as never })).toThrow(
      refusal('query'),
    );
    expect(() => parseOperation({ namespacePrefix: [], offset: -1 })).toThrow(refusal('offset'));
  });
});

describe('parseListOperation (match conditions)', () => {
  it('accepts no conditions, an empty list, wildcards, "." and "langgraph" in either path', () => {
    expect(() => parseListOperation(listing(undefined))).not.toThrow();
    expect(() => parseListOperation(listing([]))).not.toThrow();
    expect(() =>
      parseListOperation(
        listing([
          { matchType: 'prefix', path: ['langgraph', '*', 'a.b'] },
          { matchType: 'suffix', path: ['langgraph', '*'] },
        ]),
      ),
    ).not.toThrow();
  });

  it('checks paging and depth before the conditions', () => {
    expect(() => parseListOperation({ matchConditions: 'x' } as never)).toThrow(refusal('offset'));
    expect(() =>
      parseListOperation({ matchConditions: 'x', limit: 1, offset: 0, maxDepth: 0 } as never),
    ).toThrow(refusal('maxDepth'));
  });

  it('names matchConditions for a non-array, a non-object entry or an unknown type', () => {
    expect(() => parseListOperation(listing({ matchType: 'prefix', path: [] }))).toThrow(
      refusal('matchConditions'),
    );
    expect(() => parseListOperation(listing([null]))).toThrow(refusal('matchConditions'));
    expect(() => parseListOperation(listing([{ matchType: 'infix', path: [] }]))).toThrow(
      refusal('matchConditions'),
    );
  });

  it('names a path after its match type', () => {
    expect(() => parseListOperation(listing([{ matchType: 'prefix', path: 'x' }]))).toThrow(
      refusal('prefix'),
    );
    expect(() => parseListOperation(listing([{ matchType: 'suffix', path: ['a#b'] }]))).toThrow(
      refusal('suffix element'),
    );
  });
});

describe('parseOperation (put shape)', () => {
  it('accepts an object or null, with no index, index false, or field paths', () => {
    expect(() => parseOperation(put({ a: 1 }))).not.toThrow();
    expect(() => parseOperation(put(null))).not.toThrow();
    expect(() => parseOperation(put({ a: 1 }, false))).not.toThrow();
    expect(() => parseOperation(put({ a: 1 }, ['absent']))).not.toThrow();
  });

  it('refuses a bad address, then any other value, then any other index', () => {
    expect(() => parseOperation({ namespace: ['a#b'], key: 'k', value: 'x' } as never)).toThrow(
      refusal('namespace element'),
    );
    expect(() => parseOperation(put('x', 1))).toThrow(refusal('value'));
    expect(() => parseOperation(put([]))).toThrow(refusal('value'));
    expect(() => parseOperation(put({}, 'x'))).toThrow(refusal('index'));
    expect(() => parseOperation(put(null, [1]))).toThrow(refusal('index'));
  });
});

describe('parseOperation (routing)', () => {
  it('routes each operation as the store dispatches it', () => {
    const cases: [Operation, string][] = [
      [{ namespacePrefix: ['a#b'] }, 'namespacePrefix element'],
      [put('x'), 'value'],
      [{ namespace: ['ns'], key: '' }, 'key'],
      [listing([{ matchType: 'suffix', path: 1 }]), 'suffix'],
    ];
    for (const [operation, field] of cases) {
      expect(() => parseOperation(operation)).toThrow(refusal(field));
    }
    expect(() => parseOperation({ namespace: ['a.b'], key: 'k' })).not.toThrow();
  });

  it('refuses an entry that is null, a primitive or an array, naming operations', () => {
    for (const entry of [null, 42, 'x', []]) {
      expect(() => parseOperation(entry as never)).toThrow(refusal('operations'));
    }
  });
});

describe('parseOperations (batch entries)', () => {
  it('accepts an empty batch and refuses a value that is not an array', () => {
    expect(() => parseOperations([])).not.toThrow();
    expect(() => parseOperations({ namespace: ['ns'], key: 'k' } as never)).toThrow(
      refusal('operations'),
    );
  });

  it('checks every entry', () => {
    expect(() => parseOperations([{ namespace: ['ns'], key: 'k' }, null as never])).toThrow(
      refusal('operations'),
    );
  });
});
