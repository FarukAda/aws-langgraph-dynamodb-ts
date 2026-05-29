import { readFileSync } from 'node:fs';

import { countLines, findOversizedFiles, MAX_SOURCE_LINES } from './guards/line-count';
import { listSourceFiles } from './guards/source-files';

describe('countLines', () => {
  it('counts newline-separated lines, ignoring a single trailing newline', () => {
    expect(countLines('a\nb\nc')).toBe(3);
    expect(countLines('a\nb\n')).toBe(2);
    expect(countLines('')).toBe(0);
  });
});

describe('findOversizedFiles', () => {
  it('flags a file over the cap and ignores one exactly at the cap', () => {
    const overBody = Array.from({ length: MAX_SOURCE_LINES + 1 }, () => 'x').join('\n');
    const atBody = Array.from({ length: MAX_SOURCE_LINES }, () => 'x').join('\n');
    const offenders = findOversizedFiles([
      { path: 'over.ts', text: overBody },
      { path: 'ok.ts', text: atBody },
    ]);
    expect(offenders).toEqual([{ path: 'over.ts', lines: MAX_SOURCE_LINES + 1 }]);
  });
});

describe('the actual source tree', () => {
  it('has no source file over the line cap', () => {
    const files = listSourceFiles().map((path) => ({ path, text: readFileSync(path, 'utf8') }));
    expect(findOversizedFiles(files)).toEqual([]);
  });
});
