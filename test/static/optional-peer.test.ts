import { readFileSync } from 'node:fs';

import { importsOptionalPeer, mayImportOptionalPeer } from './guards/optional-peer';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('importsOptionalPeer', () => {
  it('detects static, type-only and dynamic imports of the peer', () => {
    expect(importsOptionalPeer("import { S3Client } from '@aws-sdk/client-s3';")).toBe(true);
    expect(importsOptionalPeer("import type { S3Client } from '@aws-sdk/client-s3';")).toBe(true);
    expect(importsOptionalPeer("const sdk = import('@aws-sdk/client-s3');")).toBe(true);
  });

  it('ignores other imports', () => {
    expect(importsOptionalPeer("import { x } from '@aws-sdk/client-dynamodb';")).toBe(false);
  });
});

describe('mayImportOptionalPeer', () => {
  it('allows only the S3 runtime modules, never the public config or client types', () => {
    expect(mayImportOptionalPeer(`${SRC_ROOT}/shared/codec/s3/client.ts`)).toBe(true);
    expect(mayImportOptionalPeer(`${SRC_ROOT}/shared/codec/s3/config.ts`)).toBe(false);
    expect(mayImportOptionalPeer(`${SRC_ROOT}/shared/codec/s3/client-types.ts`)).toBe(false);
    expect(mayImportOptionalPeer(`${SRC_ROOT}/shared/options.ts`)).toBe(false);
  });
});

describe('the actual source tree', () => {
  it('keeps the optional S3 peer out of every module whose declarations ship publicly (PKG-05)', () => {
    const offenders = listSourceFiles()
      .filter((path) => importsOptionalPeer(readFileSync(path, 'utf8')))
      .filter((path) => !mayImportOptionalPeer(path));
    expect(offenders).toEqual([]);
  });
});
