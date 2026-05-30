import { readFileSync } from 'node:fs';

import { findDisallowedComments } from './guards/comments';
import { listSourceFiles } from './guards/source-files';

describe('findDisallowedComments', () => {
  it('flags line comments', () => {
    expect(findDisallowedComments('const a = 1; // nope')).toEqual([1]);
  });
  it('flags non-JSDoc block comments', () => {
    expect(findDisallowedComments('/* narrative */\nconst a = 1;')).toEqual([1]);
  });
  it('allows JSDoc block comments', () => {
    expect(findDisallowedComments('/** summary */\nexport const a = 1;')).toEqual([]);
  });
  it('flags an eslint-disable line comment', () => {
    expect(findDisallowedComments('// eslint-disable-next-line\nconst a = 1;')).toEqual([1]);
  });
  it('reports the 1-based line of each offender', () => {
    expect(findDisallowedComments('export const a = 1;\nexport const b = 2; // x')).toEqual([2]);
  });
});

describe('the actual source tree', () => {
  it('contains only JSDoc comments', () => {
    const offenders = listSourceFiles().flatMap((path) => {
      const lines = findDisallowedComments(readFileSync(path, 'utf8'));
      return lines.map((line) => `${path}:${line}`);
    });
    expect(offenders).toEqual([]);
  });
});
