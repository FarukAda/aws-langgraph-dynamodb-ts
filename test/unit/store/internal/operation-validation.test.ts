import type { Operation } from '@langchain/langgraph-checkpoint';

import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  assertListOperation,
  assertOperation,
  assertOperations,
  assertPutOperation,
  assertSearchOperation,
  assertSearchPrefix,
} from '../../../../src/store/internal/operation-validation';

const refusal = (field: string) =>
  expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field } });

const listing = (matchConditions: unknown) => ({ matchConditions, limit: 10, offset: 0 }) as never;

const put = (value: unknown, index?: unknown) =>
  ({ namespace: ['ns'], key: 'k', value, index }) as never;

describe('assertSearchPrefix', () => {
  it('accepts an empty prefix, a "." and a "langgraph" root; refuses a bad key segment', () => {
    expect(() => assertSearchPrefix([])).not.toThrow();
    expect(() => assertSearchPrefix(['langgraph', 'a.b'])).not.toThrow();
    expect(() => assertSearchPrefix('x' as never)).toThrow(refusal('namespacePrefix'));
    expect(() => assertSearchPrefix(['a', ''])).toThrow(refusal('namespacePrefix element'));
  });
});

describe('assertSearchOperation', () => {
  it('checks the prefix, then filter and query, then paging, leaving absent paging alone', () => {
    expect(() => assertSearchOperation({ namespacePrefix: ['a'] })).not.toThrow();
    expect(() => assertSearchOperation({ namespacePrefix: ['a#b'], filter: 'x' as never })).toThrow(
      refusal('namespacePrefix element'),
    );
    expect(() => assertSearchOperation({ namespacePrefix: [], filter: [] as never })).toThrow(
      refusal('filter'),
    );
    expect(() => assertSearchOperation({ namespacePrefix: [], query: 1 as never })).toThrow(
      refusal('query'),
    );
    expect(() => assertSearchOperation({ namespacePrefix: [], offset: -1 })).toThrow(
      refusal('offset'),
    );
  });
});

describe('assertListOperation', () => {
  it('accepts no conditions, an empty list, wildcards, "." and "langgraph" in either path', () => {
    expect(() => assertListOperation(listing(undefined))).not.toThrow();
    expect(() => assertListOperation(listing([]))).not.toThrow();
    expect(() =>
      assertListOperation(
        listing([
          { matchType: 'prefix', path: ['langgraph', '*', 'a.b'] },
          { matchType: 'suffix', path: ['langgraph', '*'] },
        ]),
      ),
    ).not.toThrow();
  });

  it('checks paging and depth before the conditions', () => {
    expect(() => assertListOperation({ matchConditions: 'x' } as never)).toThrow(refusal('offset'));
    expect(() =>
      assertListOperation({ matchConditions: 'x', limit: 1, offset: 0, maxDepth: 0 } as never),
    ).toThrow(refusal('maxDepth'));
  });

  it('names matchConditions for a non-array, a non-object entry or an unknown type', () => {
    expect(() => assertListOperation(listing({ matchType: 'prefix', path: [] }))).toThrow(
      refusal('matchConditions'),
    );
    expect(() => assertListOperation(listing([null]))).toThrow(refusal('matchConditions'));
    expect(() => assertListOperation(listing([{ matchType: 'infix', path: [] }]))).toThrow(
      refusal('matchConditions'),
    );
  });

  it('names a path after its match type', () => {
    expect(() => assertListOperation(listing([{ matchType: 'prefix', path: 'x' }]))).toThrow(
      refusal('prefix'),
    );
    expect(() => assertListOperation(listing([{ matchType: 'suffix', path: ['a#b'] }]))).toThrow(
      refusal('suffix element'),
    );
  });
});

describe('assertPutOperation', () => {
  it('accepts an object or null, with no index, index false, or field paths', () => {
    expect(() => assertPutOperation(put({ a: 1 }))).not.toThrow();
    expect(() => assertPutOperation(put(null))).not.toThrow();
    expect(() => assertPutOperation(put({ a: 1 }, false))).not.toThrow();
    expect(() => assertPutOperation(put({ a: 1 }, ['absent']))).not.toThrow();
  });

  it('refuses a bad address, then any other value, then any other index', () => {
    expect(() => assertPutOperation({ namespace: ['a#b'], key: 'k', value: 'x' } as never)).toThrow(
      refusal('namespace element'),
    );
    expect(() => assertPutOperation(put('x', 1))).toThrow(refusal('value'));
    expect(() => assertPutOperation(put([]))).toThrow(refusal('value'));
    expect(() => assertPutOperation(put({}, 'x'))).toThrow(refusal('index'));
    expect(() => assertPutOperation(put(null, [1]))).toThrow(refusal('index'));
  });
});

describe('assertOperation', () => {
  it('routes each operation as the store dispatches it', () => {
    const cases: [Operation, string][] = [
      [{ namespacePrefix: ['a#b'] }, 'namespacePrefix element'],
      [put('x'), 'value'],
      [{ namespace: ['ns'], key: '' }, 'key'],
      [listing([{ matchType: 'suffix', path: 1 }]), 'suffix'],
    ];
    for (const [operation, field] of cases) {
      expect(() => assertOperation(operation)).toThrow(refusal(field));
    }
    expect(() => assertOperation({ namespace: ['a.b'], key: 'k' })).not.toThrow();
  });

  it('refuses an entry that is null, a primitive or an array, naming operations', () => {
    for (const entry of [null, 42, 'x', []]) {
      expect(() => assertOperation(entry as never)).toThrow(refusal('operations'));
    }
  });
});

describe('assertOperations', () => {
  it('accepts an empty batch and refuses a value that is not an array', () => {
    expect(() => assertOperations([])).not.toThrow();
    expect(() => assertOperations({ namespace: ['ns'], key: 'k' } as never)).toThrow(
      refusal('operations'),
    );
  });

  it('checks every entry', () => {
    expect(() => assertOperations([{ namespace: ['ns'], key: 'k' }, null as never])).toThrow(
      refusal('operations'),
    );
  });
});
