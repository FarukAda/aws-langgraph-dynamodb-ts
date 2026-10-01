import { resolve } from 'node:path';

import {
  allExportedFunctions,
  allTestImports,
  exportedFunctionsIn,
  importedNamesIn,
  indexReexports,
  unaddressedExports,
} from './guards/export-tests';
import { SRC_ROOT } from './guards/source-files';

describe('exportedFunctionsIn', () => {
  it('finds the exported functions and ignores the private ones', () => {
    const source = [
      'export function alpha(): void {}',
      'export async function beta(): Promise<void> {}',
      'export async function* gamma(): AsyncGenerator<void> {}',
      'function helper(): void {}',
    ].join('\n');
    expect(exportedFunctionsIn(source).map((entry) => entry.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);
  });
});

/** A test file two levels under `test/`, so `../../src/…` reaches `src/`. */
const TEST_FILE = resolve(SRC_ROOT, '..', 'test', 'unit', 'probe.test.ts');

describe('importedNamesIn', () => {
  it('names what a test imports from src, by module and binding, with or without the extension', () => {
    const source = [
      "import { readWindow, type Window } from '../../src/history/read.js';",
      "import { other } from '../../src/history/read';",
      "import * as rows from '../../src/store/internal/rows';",
      "import { Foreign } from 'some-package';",
      "import { sibling } from './helper';",
    ].join('\n');
    expect(importedNamesIn(source, TEST_FILE)).toEqual([
      'history/read#readWindow',
      'history/read#Window',
      'history/read#other',
      'store/internal/rows#*',
    ]);
  });
});

describe('indexReexports', () => {
  it('maps each re-exported name to the module that declares it', () => {
    const source = [
      "export { createSaver, createStore } from './factory/factory.js';",
      "export type { Logger } from './shared/logging/logger.js';",
    ].join('\n');
    expect([...indexReexports(source)]).toEqual([
      ['createSaver', 'factory/factory.ts'],
      ['createStore', 'factory/factory.ts'],
    ]);
  });
});

describe('unaddressedExports', () => {
  const functions = [
    { file: 'history/read.ts', name: 'readWindow' },
    { file: 'history/read.ts', name: 'readWindowInternal' },
    { file: 'factory/factory.ts', name: 'createSaver' },
    { file: 'store/internal/rows.ts', name: 'sortKey' },
  ];
  const reexports = new Map([['createSaver', 'factory/factory.ts']]);

  it('reports the exports no test imports, however often their names are mentioned', () => {
    const imports = new Set([
      'history/read#readWindow',
      'index#createSaver',
      'store/internal/rows#*',
    ]);
    expect(unaddressedExports(functions, imports, reexports)).toEqual([functions[1]]);
  });

  it('does not let the public name of one function stand for another', () => {
    const imports = new Set(['index#readWindowInternal']);
    expect(unaddressedExports([functions[1]], imports, reexports)).toEqual([functions[1]]);
  });
});

/**
 * Coverage says a line ran; this says a test was written *about* the function.
 * An export reached only through its callers has no test that states what it
 * promises, so the first change to it breaks nothing until it breaks a caller.
 * It is the import that counts, not the name: a mention in a comment, a string
 * or a test of a different function with the same name proves nothing.
 */
describe('every exported function is addressed by a test', () => {
  it('leaves no exported function unimported across the whole suite', () => {
    expect(unaddressedExports(allExportedFunctions(), allTestImports())).toEqual([]);
  });
});
