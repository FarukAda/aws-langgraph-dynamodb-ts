import assert from 'node:assert/strict';
import { test } from 'node:test';

import { collectSamples, sampleFileName } from '../../scripts/check-doc-samples.mjs';

const FENCE = '```';

test('collects ts and typescript fences and ignores js and bash', () => {
  const text = [
    `${FENCE}ts`, 'a();', FENCE,
    `${FENCE}js`, 'b();', FENCE,
    `${FENCE}typescript`, 'c();', FENCE,
    `${FENCE}bash`, 'd', FENCE,
  ].join('\n');
  const { samples, skips } = collectSamples([{ name: 'README.md', text }]);
  assert.deepEqual(samples.map((s) => [s.index, s.block.trim()]), [[0, 'a();'], [1, 'c();']]);
  assert.equal(skips.length, 0);
});

test('a skip marker with a reason skips the next fence and keeps positions stable', () => {
  const text = [
    '<!-- sample:skip needs a package this one lacks -->', `${FENCE}typescript`, 'x();', FENCE,
    `${FENCE}typescript`, 'y();', FENCE,
  ].join('\n');
  const { samples, skips, problems } = collectSamples([{ name: 'README.md', text }]);
  assert.deepEqual(skips.map((s) => s.index), [0]);
  assert.deepEqual(samples.map((s) => s.index), [1]);
  assert.deepEqual(problems, []);
});

test('a skip without a real reason is a problem', () => {
  const text = ['<!-- sample:skip why -->', `${FENCE}ts`, 'x();', FENCE].join('\n');
  assert.equal(collectSamples([{ name: 'README.md', text }]).problems.length, 1);
});

test('reads CRLF documents the same way', () => {
  const text = [`${FENCE}ts`, 'a();', FENCE].join('\r\n');
  assert.equal(collectSamples([{ name: 'README.md', text }]).samples.length, 1);
});

test('names a generated file for its document and position', () => {
  assert.equal(sampleFileName('README.md', 3), 'README_md_3.ts');
});
