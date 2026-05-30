import { readFileSync } from 'node:fs';

import { findReexports, isPublicEntry } from './guards/barrel';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('findReexports', () => {
  it('flags `export *` and `export { x } from`', () => {
    expect(findReexports("export * from './a';")).toBe(true);
    expect(findReexports("export { foo } from './a';")).toBe(true);
    expect(findReexports("export type { Foo } from './a';")).toBe(true);
  });

  it('does not flag local exports', () => {
    expect(findReexports('export const foo = 1;')).toBe(false);
    expect(findReexports('export function foo() {}')).toBe(false);
    expect(findReexports("import { foo } from './a';\nexport const bar = foo;")).toBe(false);
  });
});

describe('isPublicEntry', () => {
  it('matches only src/index.ts', () => {
    expect(isPublicEntry(`${SRC_ROOT}/index.ts`)).toBe(true);
    expect(isPublicEntry(`${SRC_ROOT}/checkpointer/saver.ts`)).toBe(false);
  });
});

describe('the actual source tree', () => {
  it('has no re-export outside the public entry', () => {
    const offenders = listSourceFiles()
      .filter((path) => !isPublicEntry(path))
      .filter((path) => findReexports(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
