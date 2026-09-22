/**
 * A script under `scripts/` must do its work, whatever path it was reached by.
 *
 * `isMain` tells a program run apart from a module imported by asking whether
 * the entry point and the calling module are the same file once symbolic
 * links are resolved — because `import.meta.filename === process.argv[1]`
 * resolves links on one side and not the other, so a script reached through a
 * linked path compares unequal, does nothing, and exits 0. Every case here
 * runs under `node --test` because `scripts/is-main.mjs` is an ESM `.mjs`
 * module the jest tier does not transpile.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { isMain } from '../../scripts/is-main.mjs';

const SCRIPTS = resolve('scripts');
let sandbox;
let linked;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'algd-is-main-'));
  linked = join(sandbox, 'scripts-link');
  // A junction on Windows, where it needs no privilege; an ordinary symbolic
  // link everywhere else, where the type is ignored.
  symlinkSync(SCRIPTS, linked, 'junction');
});

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('isMain', () => {
  const script = join(SCRIPTS, 'peer-floors.mjs');
  const moduleUrl = pathToFileURL(script).href;

  it('is true for the path the module lives at', () => {
    assert.equal(isMain(moduleUrl, script), true);
  });

  it('is true for the same file reached through a linked path', () => {
    assert.equal(isMain(moduleUrl, join(linked, 'peer-floors.mjs')), true);
  });

  it('is false for another file, which is what importing the module looks like', () => {
    assert.equal(isMain(moduleUrl, join(SCRIPTS, 'is-main.mjs')), false);
  });

  it('is false when there is no entry point at all', () => {
    assert.equal(isMain(moduleUrl, undefined), false);
  });
});

describe('a script run through a linked path', () => {
  it('peer-floors still prints the floors', () => {
    const result = spawnSync(process.execPath, [join(linked, 'peer-floors.mjs')], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /@aws-sdk\/client-s3@/);
  });
});
