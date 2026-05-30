import fc from 'fast-check';

import { matchNamespace } from '../../src/store/internal/namespace-match';

const elementArb = fc.string({ minLength: 1, maxLength: 4 }).filter((s) => s !== '*');
const namespaceArb = fc.array(elementArb, { minLength: 1, maxLength: 6 });

describe('matchNamespace (property)', () => {
  it('a namespace matches every prefix of itself', () => {
    fc.assert(
      fc.property(namespaceArb, (namespace) => {
        for (let depth = 0; depth <= namespace.length; depth++) {
          const path = namespace.slice(0, depth);
          expect(matchNamespace(namespace, { matchType: 'prefix', path })).toBe(true);
        }
      }),
    );
  });

  it('a namespace matches every suffix of itself', () => {
    fc.assert(
      fc.property(namespaceArb, (namespace) => {
        for (let depth = 0; depth <= namespace.length; depth++) {
          const path = namespace.slice(namespace.length - depth);
          expect(matchNamespace(namespace, { matchType: 'suffix', path })).toBe(true);
        }
      }),
    );
  });

  it('a path longer than the namespace never matches', () => {
    fc.assert(
      fc.property(namespaceArb, elementArb, (namespace, extra) => {
        const path = [...namespace, extra];
        expect(matchNamespace(namespace, { matchType: 'prefix', path })).toBe(false);
        expect(matchNamespace(namespace, { matchType: 'suffix', path })).toBe(false);
      }),
    );
  });

  it('an all-wildcard path no longer than the namespace always matches', () => {
    fc.assert(
      fc.property(namespaceArb, (namespace) => {
        const path = namespace.map(() => '*' as const);
        expect(matchNamespace(namespace, { matchType: 'prefix', path })).toBe(true);
        expect(matchNamespace(namespace, { matchType: 'suffix', path })).toBe(true);
      }),
    );
  });

  it('changing one concrete prefix element breaks the match', () => {
    fc.assert(
      fc.property(namespaceArb, (namespace) => {
        const path = [...namespace];
        path[0] = `${path[0]}_x`;
        expect(matchNamespace(namespace, { matchType: 'prefix', path })).toBe(false);
      }),
    );
  });
});
