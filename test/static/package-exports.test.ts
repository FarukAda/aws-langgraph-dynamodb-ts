import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SRC_ROOT } from './guards/source-files';

interface PackageManifest {
  exports: Record<string, string | Record<string, string>>;
  files: string[];
}

const manifest = JSON.parse(
  readFileSync(resolve(SRC_ROOT, '..', 'package.json'), 'utf8'),
) as PackageManifest;

describe('package exports map (PKG-18)', () => {
  it('keeps the root entry with types, import, require and default conditions', () => {
    expect(manifest.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      require: './dist/index.js',
      default: './dist/index.js',
    });
  });

  it('exports package.json for version banners and tooling, and nothing else from dist', () => {
    expect(manifest.exports['./package.json']).toBe('./package.json');
    expect(Object.keys(manifest.exports).sort()).toEqual(['.', './package.json']);
  });

  it('ships only dist, the licence and the README', () => {
    expect([...manifest.files].sort()).toEqual(['LICENSE', 'README.md', 'dist']);
  });
});
