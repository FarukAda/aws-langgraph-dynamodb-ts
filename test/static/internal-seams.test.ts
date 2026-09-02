import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { findUnmarkedSeams } from './guards/internal-seams';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

const ROOT = resolve(SRC_ROOT, '..');
const readJson = (file: string): Record<string, Record<string, boolean>> =>
  JSON.parse(readFileSync(resolve(ROOT, file), 'utf8')) as Record<string, Record<string, boolean>>;

describe('findUnmarkedSeams', () => {
  it('flags a seam property without @internal and accepts one with it', () => {
    expect(findUnmarkedSeams('interface O {\n  createClient?: () => void;\n}')).toEqual([2]);
    expect(
      findUnmarkedSeams(
        'interface O {\n  /** @internal seam */\n  createS3Client?: () => void;\n}',
      ),
    ).toEqual([]);
    expect(findUnmarkedSeams('interface O {\n  /** plain */\n  tableName: string;\n}')).toEqual([]);
  });
});

describe('the client factory seams (CORE-16)', () => {
  it('are marked @internal wherever they are declared', () => {
    const offenders = listSourceFiles().flatMap((path) =>
      findUnmarkedSeams(readFileSync(path, 'utf8')).map((line) => `${path}:${line}`),
    );
    expect(offenders).toEqual([]);
  });

  it('are stripped from the shipped declarations and the generated docs', () => {
    expect(readJson('tsconfig.build.json').compilerOptions.stripInternal).toBe(true);
    expect(readJson('typedoc.json').excludeInternal).toBe(true);
  });
});
