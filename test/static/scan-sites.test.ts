import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import {
  ALLOWED_SCAN_SITES,
  findScanCalls,
  findScanSites,
  unlistedScanSites,
} from './guards/scan-sites';
import { listSourceFiles, SRC_ROOT } from './guards/source-files';

describe('findScanCalls', () => {
  it('finds a call and ignores an import or a mention of the same name', () => {
    expect(findScanCalls('const rows = paginateScan({ client });')).toEqual([1]);
    expect(findScanCalls("import { paginateScan } from './paginate';")).toEqual([]);
    expect(findScanCalls('/** paginateScan is what a listing avoids. */')).toEqual([]);
    expect(findScanCalls('const paginateScanCount = 1;')).toEqual([]);
  });

  /**
   * A read can scan without the paginator by calling the client's own `scan`,
   * as the index backfill does, and a guard that only knew the paginator's name
   * would never see it.
   */
  it('finds a direct scan on a client, however the client is reached', () => {
    expect(findScanCalls('await client.scan({ TableName });')).toEqual([1]);
    expect(findScanCalls('const page = options.client.scan(input);')).toEqual([1]);
    const secondLine = ['', 'await context.client?.scan(input);'].join(String.fromCharCode(10));
    expect(findScanCalls(secondLine)).toEqual([2]);
    expect(findScanCalls('const scan = 1; scan + 1;')).toEqual([]);
    expect(findScanCalls('/** client.scan( is what a listing avoids. */')).toEqual([]);
    expect(findScanCalls('await client.query({ TableName });')).toEqual([]);
  });
});

describe('unlistedScanSites', () => {
  it('refuses a direct client scan in a file the design does not name', () => {
    const sites = findScanSites([
      { path: 'store/actions/rogue.ts', text: 'await context.client.scan({ TableName });' },
    ]);
    expect(unlistedScanSites(sites)).toEqual([{ path: 'store/actions/rogue.ts', line: 1 }]);
  });

  it('passes the index backfill and the paginator, which the design names', () => {
    const sites = findScanSites([
      { path: 'shared/dynamodb/backfill-index.ts', text: 'await options.client.scan(input);' },
      { path: 'shared/dynamodb/paginate.ts', text: 'return options.client.scan(input);' },
    ]);
    expect(sites).toHaveLength(2);
    expect(unlistedScanSites(sites)).toEqual([]);
  });
});

/**
 * A `Scan` reads the whole table and then filters, which AWS names as the thing
 * to avoid for a production access pattern. This package may still scan, but
 * only where no key condition could have served the read — the four reads, the
 * index backfill and the paginator named in `ALLOWED_SCAN_SITES`, whose doc
 * states the rule.
 *
 * The list is the point: a read that starts scanning outside it has an access
 * pattern a key *could* have served, and that is the defect this guard exists
 * to catch while it is still a diff.
 */
describe('the source files that scan', () => {
  const sites = findScanSites(
    listSourceFiles().map((path) => ({
      path: relative(SRC_ROOT, path).split('\\').join('/'),
      text: readFileSync(path, 'utf8'),
    })),
  );

  it('are exactly the ones the design names', () => {
    expect(unlistedScanSites(sites)).toEqual([]);
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
