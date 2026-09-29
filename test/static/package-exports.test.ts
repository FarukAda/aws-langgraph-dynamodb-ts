import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SRC_ROOT } from './guards/source-files';

/** One condition's target: a file, or a nested map with its own `types`. */
type ExportTarget = string | { [condition: string]: ExportTarget };

interface PackageManifest {
  type: string;
  main: string;
  types: string;
  exports: Record<string, ExportTarget>;
  files: string[];
}

const manifest = JSON.parse(
  readFileSync(resolve(SRC_ROOT, '..', 'package.json'), 'utf8'),
) as PackageManifest;

describe('package exports map', () => {
  /**
   * Each module system gets its own build and its own declarations, so an ESM
   * application never loads the CommonJS copies of the peers beside its own
   * (decision record 29).
   */
  it('sends import to the ES-module build and require to the CommonJS one', () => {
    expect(manifest.exports['.']).toEqual({
      import: { types: './dist/esm/index.d.ts', default: './dist/esm/index.js' },
      require: { types: './dist/cjs/index.d.ts', default: './dist/cjs/index.js' },
    });
  });

  it('points the legacy main and types fields at the CommonJS build', () => {
    expect(manifest.type).toBe('module');
    expect(manifest.main).toBe('./dist/cjs/index.js');
    expect(manifest.types).toBe('./dist/cjs/index.d.ts');
  });

  it('exports package.json for version banners and tooling, and nothing else from dist', () => {
    expect(manifest.exports['./package.json']).toBe('./package.json');
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './package.json']);
  });

  it('ships only dist, the licence and the README', () => {
    expect([...manifest.files].sort()).toEqual(['LICENSE', 'README.md', 'dist']);
  });
});
