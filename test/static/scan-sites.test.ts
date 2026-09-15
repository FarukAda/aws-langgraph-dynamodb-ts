import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { ALLOWED_SCAN_SITES, findScanCalls, findScanSites } from './guards/scan-sites';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('findScanCalls', () => {
  it('finds a call and ignores an import or a mention of the same name', () => {
    expect(findScanCalls('const rows = paginateScan({ client });')).toEqual([1]);
    expect(findScanCalls("import { paginateScan } from './scan';")).toEqual([]);
    expect(findScanCalls('/** paginateScan is what a listing avoids. */')).toEqual([]);
    expect(findScanCalls('const paginateScanCount = 1;')).toEqual([]);
  });
});

/**
 * A `Scan` reads the whole table and then filters, which AWS names as the thing
 * to avoid for a production access pattern. This package may still scan, but
 * only where no key condition could have served the read — the four reads named
 * in `ALLOWED_SCAN_SITES` (DESIGN D-1).
 *
 * The list is the point: a read that starts scanning outside it has an access
 * pattern a key *could* have served, and that is the defect this guard exists
 * to catch while it is still a diff.
 */
describe('the reads that scan', () => {
  const sites = findScanSites(
    listSourceFiles().map((path) => ({
      path: relative(SRC_ROOT, path).split('\\').join('/'),
      text: readFileSync(path, 'utf8'),
    })),
  );

  it('are exactly the ones the design names', () => {
    expect([...new Set(sites.map((site) => site.path))].sort()).toEqual(
      Object.keys(ALLOWED_SCAN_SITES).sort(),
    );
  });

  it('each give a reason a key condition cannot serve them', () => {
    for (const reason of Object.values(ALLOWED_SCAN_SITES)) {
      expect(reason.length).toBeGreaterThan(0);
    }
  });
});
