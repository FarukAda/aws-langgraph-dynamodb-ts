import { actualEntries, listedEntries } from './guards/project-structure';

/**
 * The README's tree is the map a new contributor reads first, and nothing
 * regenerates it: a script, a workflow or a test tier added later is simply
 * absent from it, and one removed is still described.
 */
describe("the README's project structure", () => {
  it.each(['src', 'test', 'scripts', '.github/workflows'])(
    'lists everything directly under %s/, and nothing that is not there',
    (root) => {
      expect([...listedEntries(root)].sort()).toEqual([...actualEntries(root)].sort());
    },
  );

  /**
   * One direction only: a working copy holds ignored planning notes under
   * `docs/`, which a checkout does not, so what is on disk is not the list.
   */
  it('lists nothing under docs/ that is not there', () => {
    const present = new Set(actualEntries('docs'));
    expect(listedEntries('docs').length).toBeGreaterThan(0);
    expect(listedEntries('docs').filter((entry) => !present.has(entry))).toEqual([]);
  });
});

describe('guard internals', () => {
  const readme = [
    '## Project structure',
    '',
    '```text',
    'src/',
    '├── index.ts       # the surface',
    '├── shared/        # shared code',
    '│   ├── nested.ts  # not a first-level entry',
    '│   └── deep/      # nor this',
    '└── store/         # the store',
    '    └── inner.ts   # nor this',
    '',
    'examples/          # demos',
    '',
    'scripts/',
    '└── clean.mjs      # removes dist',
    '```',
  ].join('\n');

  it('reads the first level of a block and stops at the blank line ending it', () => {
    expect(listedEntries('src', readme)).toEqual(['index.ts', 'shared', 'store']);
    expect(listedEntries('scripts', readme)).toEqual(['clean.mjs']);
  });

  it('reads a root written with a trailing comment as a block with no entries', () => {
    expect(listedEntries('examples', readme)).toEqual([]);
  });

  it('fails loudly on a root the tree does not have, and on a README without the tree', () => {
    expect(() => listedEntries('docs', readme)).toThrow('no "docs/" block');
    expect(() => listedEntries('src', '# nothing here')).toThrow('Project structure');
  });
});
