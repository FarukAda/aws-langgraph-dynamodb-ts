import { resolve } from 'node:path';

import fc from 'fast-check';

import type { JsonValue } from '../../src/store/internal/filter';
import { getTextAtPath, tokenizePath } from '../../src/store/internal/text-path';

// The implementation InMemoryStore actually uses (the package root exports a
// string-only variant); reached by absolute path because it is not in the
// package's `exports` map.
const reference = jest.requireActual<{
  getTextAtPath: (obj: JsonValue, path: string) => string[];
  tokenizePath: (path: string) => string[];
}>(resolve('node_modules/@langchain/langgraph-checkpoint/dist/store/utils.cjs'));

const scalar = fc.oneof(
  fc.string({ maxLength: 6 }),
  fc.integer({ min: -5, max: 5 }),
  fc.boolean(),
  fc.constant(null),
);
const key = fc.constantFrom('a', 'b', 'c', 'title', 'name', 'tags', 'length');
const json: fc.Arbitrary<JsonValue> = fc.letrec<{ node: JsonValue }>((tie) => ({
  node: fc.oneof(
    { depthSize: 'small', maxDepth: 3 },
    scalar,
    fc.array(tie('node'), { maxLength: 3 }),
    fc.dictionary(key, tie('node'), { maxKeys: 3 }),
  ),
})).node;
const token = fc.oneof(
  key,
  fc.constant('*'),
  fc.constant('$'),
  fc.constant('0'),
  fc.constantFrom('[0]', '[1]', '[-1]', '[*]', '[x]'),
  fc.constantFrom('{a,b}', '{title,a.b}', '{tags[0]}', '{ a , length }'),
);
const path = fc
  .array(token, { minLength: 1, maxLength: 3 })
  .map((tokens) =>
    tokens.reduce((acc, t) => (acc === '' || t.startsWith('[') ? `${acc}${t}` : `${acc}.${t}`), ''),
  );

describe('text-path parity with @langchain/langgraph-checkpoint store/utils', () => {
  it('tokenizes every generated path identically', () => {
    fc.assert(
      fc.property(path, (p) => {
        expect(tokenizePath(p)).toEqual(reference.tokenizePath(p));
      }),
    );
  });

  it('extracts identical text for every generated document and path', () => {
    fc.assert(
      fc.property(json, path, (doc, p) => {
        expect(getTextAtPath(doc, p)).toEqual(reference.getTextAtPath(doc, p));
      }),
      { numRuns: 500 },
    );
  });
});
