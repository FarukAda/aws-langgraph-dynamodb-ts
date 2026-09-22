/**
 * What the peer-floor job installs.
 *
 * The job's whole value is that it installs the *lowest* version each
 * declared range admits and runs the type checks and unit tier against it, so
 * a floor that was never published — or that the code cannot work against —
 * fails in CI rather than on the consumer who pinned it. That only holds if
 * the floor is really the floor. The inline shell it replaced silently
 * installed the newest match for a `>=`, an x-range or a `*`, and word-split
 * a `||` union into an install of a package called `||`, leaving the job
 * green having proved nothing.
 *
 * `scripts/` is outside jest's coverage collection, so nothing here moves the
 * coverage gate; it runs under `node --test` because `peer-floors.mjs` is an
 * ESM `.mjs` module.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { floorOf, peerFloors } from '../../scripts/peer-floors.mjs';

describe('floorOf', () => {
  const cases = [
    ['^3.1133.0', '3.1133.0'],
    ['~1.2.3', '1.2.3'],
    ['>=1.0.0', '1.0.0'],
    ['=1.0.0', '1.0.0'],
    ['1.2.3', '1.2.3'],
    ['^1.0.0-rc.1', '1.0.0-rc.1'],
    ['  ^2.0.0  ', '2.0.0'],
  ];
  for (const [range, expected] of cases) {
    it(`reduces ${range} to ${expected}`, () => {
      assert.equal(floorOf('p', range), expected);
    });
  }

  const refused = ['1.x', '1.*', '*', 'x', '^1.0.0 || ^2.0.0', '>=1.0.0 <2.0.0', 'latest', ''];
  for (const range of refused) {
    it(`refuses ${JSON.stringify(range)} rather than guessing`, () => {
      assert.throws(() => floorOf('p', range), /Cannot determine the floor/);
    });
  }

  it('names the dependency it could not reduce', () => {
    assert.throws(() => floorOf('@scope/thing', '*'), /@scope\/thing/);
  });
});

describe('peerFloors', () => {
  it('produces one npm spec per declared peer, in declaration order', () => {
    assert.deepEqual(peerFloors({ peerDependencies: { b: '^2.0.0', a: '~1.5.0' } }), [
      'b@2.0.0',
      'a@1.5.0',
    ]);
  });

  it('is empty when nothing is declared', () => {
    assert.deepEqual(peerFloors({}), []);
  });

  it('reduces this package’s own declared ranges', async () => {
    // The real manifest, so a range added later that this cannot reduce fails
    // here rather than in a CI job whose failure reads as something else.
    const manifest = JSON.parse(await readFile('package.json', 'utf8'));
    const specs = peerFloors(manifest);
    assert.ok(specs.length > 0);
    for (const spec of specs) assert.match(spec, /@\d+\.\d+\.\d+/);
  });
});
