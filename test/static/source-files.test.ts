import { join } from 'node:path';

import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('listSourceFiles', () => {
  it('returns absolute paths to every .ts file under src, excluding declarations', () => {
    const files = listSourceFiles();
    expect(files.length).toBeGreaterThan(0);
    expect(files.every((f) => f.endsWith('.ts'))).toBe(true);
    expect(files.some((f) => f.endsWith('.d.ts'))).toBe(false);
    expect(files).toContain(join(SRC_ROOT, 'index.ts'));
  });
});
