import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_S3_KEY_PREFIX,
  DEFAULT_SOCKET_TIMEOUT_MS,
  S3_RELEASE_GRACE_DAYS,
} from '../../src/shared/constants';
import { readReadme } from './guards/iam-actions';
import { SRC_ROOT } from './guards/source-files';

/** The repository root, one level above the source tree. */
const REPO_ROOT = resolve(SRC_ROOT, '..');

/** The sweep script, which is repository-only and never shipped in the tarball. */
const SCRIPT_PATH = 'scripts/find-stranded-payloads.mjs';

const scriptText = (): string => readFileSync(resolve(REPO_ROOT, SCRIPT_PATH), 'utf8');

/**
 * The literal one of the script's exported defaults is declared with, read from
 * its text rather than imported: the point is that the two files agree on the
 * number, and importing it would make any value agree with itself.
 */
function declaredDefault(name: string): string {
  const match = new RegExp(`^export const ${name} = (.+);$`, 'm').exec(scriptText());
  if (match === null) throw new Error(`${SCRIPT_PATH} declares no ${name}`);
  return match[1];
}

/** The same literal as a number, since the script writes milliseconds with digit separators. */
function declaredNumber(name: string): number {
  return Number(declaredDefault(name).replaceAll('_', ''));
}

describe('the sweep script and the constants it mirrors', () => {
  it('defaults its grace window to the same number of days the lifecycle rule writes', () => {
    expect(declaredDefault('DEFAULT_GRACE_DAYS')).toBe(String(S3_RELEASE_GRACE_DAYS));
  });

  it('defaults its prefix to the same base prefix the adapters offload under', () => {
    expect(declaredDefault('DEFAULT_PREFIX')).toBe(`'${DEFAULT_S3_KEY_PREFIX}'`);
  });

  it('bounds one request with the same milliseconds the adapters bound one with', () => {
    expect(declaredNumber('DEFAULT_REQUEST_TIMEOUT_MS')).toBe(DEFAULT_REQUEST_TIMEOUT_MS);
  });

  it('bounds an idle socket with the same milliseconds the adapters bound one with', () => {
    expect(declaredNumber('DEFAULT_SOCKET_TIMEOUT_MS')).toBe(DEFAULT_SOCKET_TIMEOUT_MS);
  });

  it('refuses a name it cannot find, so a renamed default fails here rather than drifting', () => {
    expect(() => declaredDefault('DEFAULT_NOTHING')).toThrow(/declares no DEFAULT_NOTHING/);
  });
});

describe('the sweep script stays out of the published package', () => {
  it('is named by its repository path in the README, which says it is not in the tarball', () => {
    const readme = readReadme();
    expect(readme).toContain(SCRIPT_PATH);
    expect(readme).toMatch(/not (?:in|part of) the (?:npm )?(?:tarball|package)/i);
  });

  it('is not listed in the files the manifest publishes, and adds no bin entry', () => {
    const manifest = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      files: string[];
      bin?: Record<string, string>;
    };
    expect(manifest.files).toEqual(['dist', 'LICENSE', 'README.md']);
    expect(manifest.bin).toBeUndefined();
  });
});
