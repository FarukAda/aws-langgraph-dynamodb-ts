import { contractGaps, contractGapsIn, REQUIRED_SECTIONS } from './guards/export-contracts';

describe('contractGapsIn', () => {
  const full = [
    '/**',
    ' * Does a thing.',
    ' *',
    ' * Accepts: a number.',
    ' *',
    ' * Returns: another number.',
    ' *',
    ' * Throws: nothing.',
    ' */',
    'export function twice(n: number): number { return n * 2; }',
  ].join('\n');

  it('accepts a function whose doc states the whole contract', () => {
    expect(contractGapsIn(full)).toEqual([]);
  });

  it('names every section a doc omits', () => {
    expect(contractGapsIn('/** Does a thing. */\nexport function f(): void {}')).toEqual([
      { file: 'source.ts', name: 'f', missing: [...REQUIRED_SECTIONS] },
    ]);
  });

  it('reads only the doc comment directly above the declaration', () => {
    const source = `${full}\n\n/** Bare. */\nexport function once(n: number): number { return n; }`;
    expect(contractGapsIn(source).map((gap) => gap.name)).toEqual(['once']);
  });

  it('ignores a function the file does not export', () => {
    expect(contractGapsIn('function helper(): void {}')).toEqual([]);
  });
});

/**
 * `docs/CONTRACTS.md` asks every exported function to state what it accepts,
 * what it returns and what it throws. Stating it is what forces the cells to be
 * decided rather than discovered by a caller.
 */
describe('every exported function states its contract (DOCS-08)', () => {
  it('leaves no exported function without Accepts, Returns and Throws', () => {
    expect(contractGaps()).toEqual([]);
  });
});
