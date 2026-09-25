import {
  allExportedFunctions,
  allTestSources,
  exportedFunctionsIn,
  unaddressedExports,
} from './guards/export-tests';

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

describe('unaddressedExports', () => {
  it('reports the exports no test names, matching whole words only', () => {
    const functions = [
      { file: 'a.ts', name: 'readWindow' },
      { file: 'a.ts', name: 'readWindowInternal' },
    ];
    expect(unaddressedExports(functions, 'expect(readWindow(x))')).toEqual([functions[1]]);
  });
});

/**
 * Coverage says a line ran; this says a test was written *about* the function.
 * An export reached only through its callers has no test that states what it
 * promises, so the first change to it breaks nothing until it breaks a caller.
 */
describe('every exported function is addressed by a test', () => {
  it('leaves no exported function unnamed across the whole suite', () => {
    expect(unaddressedExports(allExportedFunctions(), allTestSources())).toEqual([]);
  });
});
