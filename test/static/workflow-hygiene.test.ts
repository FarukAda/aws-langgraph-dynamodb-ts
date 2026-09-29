import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { jobBodies } from './guards/release-gate';
import { SRC_ROOT } from './guards/source-files';

const WORKFLOWS = resolve(SRC_ROOT, '..', '.github', 'workflows');
const files = readdirSync(WORKFLOWS).filter((file) => file.endsWith('.yml'));

/**
 * Two properties every job keeps, whichever workflow it is in. A job with no
 * `timeout-minutes` runs for GitHub's default of six hours when a step hangs,
 * holding a runner the whole time; and a checkout that persists its token
 * leaves a credential in `.git/config` for every later step to read, `npm ci`
 * and the packages it runs included, in a repository whose jobs push nothing.
 */
describe('every workflow', () => {
  it.each(files)('%s bounds every job with timeout-minutes', (file) => {
    const jobs = Object.entries(jobBodies(file));
    expect(jobs.length).toBeGreaterThan(0);
    for (const [id, lines] of jobs) {
      expect([id, lines.some((line) => /^ {4}timeout-minutes:\s*\d+/.test(line))]).toEqual([
        id,
        true,
      ]);
    }
  });

  it.each(files)('%s leaves no credential behind on a checkout', (file) => {
    const lines = readFileSync(resolve(WORKFLOWS, file), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/uses: actions\/checkout@/.test(line)) return;
      const block = lines.slice(index + 1, index + 6).join('\n');
      expect([file, index + 1, /persist-credentials:\s*false/.test(block)]).toEqual([
        file,
        index + 1,
        true,
      ]);
    });
  });
});
