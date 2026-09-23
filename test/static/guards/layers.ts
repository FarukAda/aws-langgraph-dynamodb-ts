import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

import * as ts from 'typescript';

import { listSourceFiles, SRC_ROOT } from './source-files';

/**
 * The layers of `src/`, innermost first. A module may import from its own layer
 * or from any layer before it, and nothing else. The table is the rule: a
 * module it does not place fails too, so a new one cannot escape by being
 * unlisted. Type-only imports count — they leave no runtime cycle, which is
 * exactly why nothing else would notice them.
 */
export const LAYERS = [
  'shared',
  'declarations',
  'internal',
  'actions',
  'adapter',
  'factory',
  'entry',
] as const;
export type Layer = (typeof LAYERS)[number];

/** The features, which never import each other. */
export const FEATURES: readonly string[] = ['checkpointer', 'store', 'history'];

/** Directory prefixes and the layer everything under them belongs to. */
const DIRECTORY_LAYERS: Readonly<Record<string, Layer>> = {
  shared: 'shared',
  'checkpointer/internal': 'internal',
  'store/internal': 'internal',
  'history/internal': 'internal',
  'checkpointer/actions': 'actions',
  'store/actions': 'actions',
  'history/actions': 'actions',
  factory: 'factory',
};

/** Single modules and their layer. */
const MODULE_LAYERS: Readonly<Record<string, Layer>> = {
  'checkpointer/types.ts': 'declarations',
  'store/types.ts': 'declarations',
  'store/vector-backend.ts': 'declarations',
  'history/types.ts': 'declarations',
  'checkpointer/saver.ts': 'adapter',
  'store/store.ts': 'adapter',
  'history/chat-message-history.ts': 'adapter',
  'history/session-adapter.ts': 'adapter',
  'index.ts': 'entry',
};

/** One upward import accepted on purpose. */
export interface PermittedImport {
  from: string;
  to: string;
  /** Why it is not a violation nobody fixed, and what removing it would cost. */
  reason: string;
}

/** None today. An entry that stops matching a real import fails the suite. */
export const PERMITTED_UPWARD_IMPORTS: readonly PermittedImport[] = [];

/** One import, both ends relative to `src/` with `/` separators. */
export interface Edge {
  from: string;
  to: string;
}

/** The layer `file` belongs to, or `undefined` when the table does not place it. */
export function layerOf(file: string): Layer | undefined {
  if (Object.hasOwn(MODULE_LAYERS, file)) return MODULE_LAYERS[file];
  const directory = Object.keys(DIRECTORY_LAYERS)
    .filter((prefix) => file.startsWith(`${prefix}/`))
    .sort((a, b) => b.length - a.length)[0];
  return directory === undefined ? undefined : DIRECTORY_LAYERS[directory];
}

/** The feature `file` belongs to, if any. */
export function featureOf(file: string): string | undefined {
  const first = file.split('/')[0];
  return FEATURES.includes(first) ? first : undefined;
}

/** `specifier`, written in `file`, as a module path relative to `src/`. */
function resolveInSrc(file: string, specifier: string): string {
  const base = resolve(SRC_ROOT, dirname(file), specifier);
  const target =
    [`${base}.ts`, resolve(base, 'index.ts')].find((candidate) => existsSync(candidate)) ??
    `${base}.ts`;
  return relative(SRC_ROOT, target).split(sep).join('/');
}

/** Every relative import and re-export `source` makes, type-only included. */
export function edgesIn(source: string, file: string): Edge[] {
  return ts
    .preProcessFile(source, true, true)
    .importedFiles.filter((imported) => imported.fileName.startsWith('.'))
    .map((imported) => ({ from: file, to: resolveInSrc(file, imported.fileName) }));
}

/** Every module under `src/`, relative to it. */
export function sourceFiles(): string[] {
  return listSourceFiles().map((path) => relative(SRC_ROOT, path).split(sep).join('/'));
}

/** Every import in `src/`. */
export function sourceEdges(): Edge[] {
  return sourceFiles().flatMap((file) =>
    edgesIn(readFileSync(resolve(SRC_ROOT, file), 'utf8'), file),
  );
}

const label = ({ from, to }: Edge): string => `${from} -> ${to}`;

/** Each import that reaches a later layer and is not permitted, described with both layers. */
export function upwardImports(
  edges: readonly Edge[],
  permitted: readonly PermittedImport[] = PERMITTED_UPWARD_IMPORTS,
): string[] {
  const allowed = new Set(permitted.map(label));
  return edges
    .filter(({ from, to }) => {
      const source = layerOf(from);
      const target = layerOf(to);
      return (
        source !== undefined &&
        target !== undefined &&
        LAYERS.indexOf(target) > LAYERS.indexOf(source)
      );
    })
    .filter((edge) => !allowed.has(label(edge)))
    .map((edge) => `${layerOf(edge.from)} ${edge.from} -> ${layerOf(edge.to)} ${edge.to}`);
}

/** Each import from one feature into another. */
export function crossFeatureImports(edges: readonly Edge[]): string[] {
  return edges
    .filter(({ from, to }) => {
      const source = featureOf(from);
      const target = featureOf(to);
      return source !== undefined && target !== undefined && source !== target;
    })
    .map(label);
}

/** Each permitted exception that no longer matches an import. */
export function staleExceptions(
  edges: readonly Edge[],
  permitted: readonly PermittedImport[] = PERMITTED_UPWARD_IMPORTS,
): string[] {
  const present = new Set(edges.map(label));
  return permitted.map(label).filter((edge) => !present.has(edge));
}
