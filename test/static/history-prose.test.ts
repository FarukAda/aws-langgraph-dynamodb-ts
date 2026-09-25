import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import { historyProse } from './guards/history-prose';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('historyProse', () => {
  it('finds each history phrase in a comment, by line', () => {
    const source = [
      '/**',
      ' * A cap of 0 used to yield one item.',
      ' * Named alike until now.',
      ' */',
      'const a = 1;',
      '// previously a string',
      '// Formerly unbounded',
    ].join('\n');
    expect(historyProse(source)).toEqual([2, 3, 6, 7]);
  });

  it('leaves code and strings alone', () => {
    expect(historyProse("const message = 'the value used to build it';")).toEqual([]);
  });
});

describe('the source tree', () => {
  it('says why the code is as it is, not what it used to do', () => {
    const hits = listSourceFiles().flatMap((path) =>
      historyProse(readFileSync(path, 'utf8')).map(
        (line) => `${relative(SRC_ROOT, path).split(sep).join('/')}:${line}`,
      ),
    );
    expect(hits).toEqual([]);
  });
});
