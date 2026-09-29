import { readFileSync } from 'node:fs';

import * as ts from 'typescript';

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
  /**
   * The cycle check is only as good as the graph: a relative import the
   * builder cannot resolve is an edge it drops without a word, and a graph with
   * every edge dropped has no cycle to find.
   */
  it('resolves every relative import to an edge of the graph', () => {
    const files = listSourceFiles();
    const relativeImports = files.flatMap((file) =>
      ts
        .preProcessFile(readFileSync(file, 'utf8'), true, true)
        .importedFiles.filter((imported) => imported.fileName.startsWith('.')),
    );
    const edges = [...buildImportGraph(files).values()].flat();
    expect(relativeImports.length).toBeGreaterThan(0);
    expect(edges).toHaveLength(relativeImports.length);
  });

  it('has no circular dependencies between modules', () => {
    const cycles = detectCycles(buildImportGraph(listSourceFiles()));
    expect(cycles).toEqual([]);
  });
});
