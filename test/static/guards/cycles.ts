import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import * as ts from 'typescript';

/** A detected dependency cycle: the ordered file paths that close the loop. */
export type ImportCycle = string[];

/**
 * Resolve a relative import `specifier` written in `fromFile` to the absolute
 * source file it targets, or undefined when it is a bare (package) import or
 * resolves outside the scanned tree.
 */
function resolveRelativeImport(fromFile: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [`${base}.ts`, join(base, 'index.ts')];
  return candidates.find((candidate) => existsSync(candidate));
}

/**
 * Build the directed import graph for `files`: each file maps to the in-tree
 * source files it imports via relative specifiers (type-only imports included).
 * External package imports are ignored.
 */
export function buildImportGraph(files: string[]): Map<string, string[]> {
  const known = new Set(files);
  const graph = new Map<string, string[]>();
  for (const file of files) {
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    const edges = info.importedFiles
      .map((imported) => resolveRelativeImport(file, imported.fileName))
      .filter((target): target is string => target !== undefined && known.has(target));
    graph.set(file, edges);
  }
  return graph;
}

/**
 * Detect dependency cycles in `graph` via depth-first search, returning one
 * representative ordered path per cycle (the closing node repeated at the end).
 */
export function detectCycles(graph: Map<string, string[]>): ImportCycle[] {
  const visited = new Set<string>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const cycles: ImportCycle[] = [];
  const walk = (node: string): void => {
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) {
      if (onStack.has(next)) {
        cycles.push([...stack.slice(stack.indexOf(next)), next]);
      } else if (!visited.has(next)) {
        walk(next);
      }
    }
    stack.pop();
    onStack.delete(node);
  };
  for (const node of graph.keys()) {
    if (!visited.has(node)) walk(node);
  }
  return cycles;
}
