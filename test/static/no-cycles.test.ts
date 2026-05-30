import { buildImportGraph, detectCycles } from './guards/cycles';
import { listSourceFiles } from './guards/source-files';

describe('detectCycles', () => {
  it('returns an empty list for an acyclic graph', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', []],
    ]);
    expect(detectCycles(graph)).toEqual([]);
  });

  it('detects a direct two-node cycle', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['a']],
    ]);
    const [cycle] = detectCycles(graph);
    expect(cycle).toContain('a');
    expect(cycle).toContain('b');
  });

  it('detects a longer transitive cycle', () => {
    const graph = new Map<string, string[]>([
      ['a', ['b']],
      ['b', ['c']],
      ['c', ['a']],
    ]);
    expect(detectCycles(graph).length).toBeGreaterThan(0);
  });
});

describe('the actual source tree', () => {
  it('has no circular dependencies between modules', () => {
    const cycles = detectCycles(buildImportGraph(listSourceFiles()));
    expect(cycles).toEqual([]);
  });
});
