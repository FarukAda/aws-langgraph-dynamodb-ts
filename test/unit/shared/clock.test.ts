import { readFileSync } from 'node:fs';
import { relative } from 'node:path';

import { nowIso, nowSeconds } from '../../../src/shared/clock';
import { FROZEN_NOW_MS } from '../../shared/helpers/test-setup';
import { listSourceFiles, SRC_ROOT } from '../../static/guards/source-files';

describe('nowIso', () => {
  it('returns the frozen clock time as an ISO string', () => {
    expect(nowIso()).toBe(new Date(FROZEN_NOW_MS).toISOString());
  });
});

describe('nowSeconds', () => {
  it('returns the frozen clock time as whole epoch seconds, rounded down', () => {
    expect(nowSeconds()).toBe(Math.floor(FROZEN_NOW_MS / 1000));
  });
});

describe('the clock seam', () => {
  it('is the only place in src/ that reads Date.now() directly', () => {
    // TTL stamping, expiry filtering and the ttl anchor must all agree on one
    // notion of "now" so a frozen or skewed clock affects them identically.
    const offenders = listSourceFiles()
      .filter((path) => readFileSync(path, 'utf8').includes('Date.now()'))
      .map((path) => relative(SRC_ROOT, path).replace(/\\/g, '/'));
    expect(offenders).toEqual(['shared/clock.ts']);
  });
});
