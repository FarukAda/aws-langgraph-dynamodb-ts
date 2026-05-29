import { readFileSync } from 'node:fs';

import { findForbiddenTypes } from './guards/forbidden-types';
import { listSourceFiles } from './guards/source-files';

describe('findForbiddenTypes', () => {
  it('flags the any keyword in a type position', () => {
    expect(findForbiddenTypes('const a: any = 1;')).toEqual([1]);
    expect(findForbiddenTypes('const a = x as any;')).toEqual([1]);
  });
  it('flags the unknown keyword', () => {
    expect(findForbiddenTypes('function f(x: unknown) {}')).toEqual([1]);
  });
  it('does not flag the identifier "unknown" used as a value name', () => {
    expect(findForbiddenTypes('const unknownCount = 1;')).toEqual([]);
  });
  it('does not flag clean code', () => {
    expect(findForbiddenTypes('export const a: number = 1;')).toEqual([]);
  });
});

describe('the actual source tree', () => {
  it('has no any or unknown keyword', () => {
    const offenders = listSourceFiles().flatMap((path) => {
      const lines = findForbiddenTypes(readFileSync(path, 'utf8'));
      return lines.map((line) => `${path}:${line}`);
    });
    expect(offenders).toEqual([]);
  });
});
