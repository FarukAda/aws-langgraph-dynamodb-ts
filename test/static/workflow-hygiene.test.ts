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

/**
 * An action is pinned by commit, and the comment beside the pin is the only
 * place a reader — and Dependabot, which rewrites it — learns which release
 * that commit is. One commit named two ways (`v7` here, `v7.0.1` there) says
 * two different things about the same code.
 */
describe('every pinned action', () => {
  /** Each `uses: <action>@<sha> # <version>` across the workflows, as written. */
  const pins = files.flatMap((file) =>
    readFileSync(resolve(WORKFLOWS, file), 'utf8')
      .split('\n')
      .flatMap((line, index) => {
        const pin = /uses:\s*(\S+)@([0-9a-f]{40})\s*#\s*(\S+)/.exec(line);
        return pin ? [{ at: `${file}:${index + 1}`, sha: pin[2], version: pin[3] }] : [];
      }),
  );

  it('finds the pins to check, so a broken scan cannot pass silently', () => {
    expect(pins.length).toBeGreaterThanOrEqual(10);
  });

  it('names a full release beside the commit, the same one wherever that commit is pinned', () => {
    const versions = new Map<string, string>();
    for (const pin of pins) versions.set(pin.sha, versions.get(pin.sha) ?? pin.version);
    const misnamed = pins.filter(
      (pin) => !/^v\d+\.\d+\.\d+$/.test(pin.version) || versions.get(pin.sha) !== pin.version,
    );
    expect(misnamed.map((pin) => `${pin.at} # ${pin.version}`)).toEqual([]);
  });
});
