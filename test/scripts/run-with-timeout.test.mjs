/**
 * Unit tests for `scripts/run-with-timeout.mjs`, run with `node --test` via
 * `npm run test:scripts` because the script is an ESM `.mjs` module and the
 * jest tier transpiles CommonJS.
 *
 * `test:surface` uses this wrapper as its hard stop: `node --test
 * --test-timeout=N` bounds only a test's own body, not a hang after the last
 * test has already passed. These tests exercise real child processes, not a
 * fake `spawn`, because the one thing worth proving is that a kill this
 * wrapper sends actually reaches a real OS process tree on this platform — a
 * fake would only prove the wrapper calls the functions it calls.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers';

import { runWithTimeout } from '../../scripts/run-with-timeout.mjs';

const SCRIPT = join('scripts', 'run-with-timeout.mjs');

let sandbox;
before(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'algd-run-with-timeout-'));
});
after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

describe('runWithTimeout', () => {
  it('propagates the exit code of a command that finishes before the timeout', async () => {
    const started = Date.now();
    const result = await runWithTimeout(process.execPath, ['-e', 'process.exit(7)'], 5000);
    assert.deepEqual(result, { status: 7, timedOut: false });
    // Nothing about a normal exit should ever wait for the timeout itself.
    assert.ok(Date.now() - started < 4000, 'a command that exits on its own should not wait out the timeout');
  });

  it('reports a failing command\'s own exit code, not a timeout', async () => {
    const result = await runWithTimeout(process.execPath, ['-e', 'process.exit(3)'], 5000);
    assert.deepEqual(result, { status: 3, timedOut: false });
  });

  it('kills a command that outlives the timeout, well before it would exit on its own', async () => {
    const started = Date.now();
    // This command would otherwise run for a full minute.
    const result = await runWithTimeout(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], 300);
    const elapsed = Date.now() - started;
    assert.equal(result.timedOut, true);
    assert.equal(result.status, null);
    assert.ok(elapsed < 55_000, `expected the kill to cut the 60s command short, took ${elapsed}ms`);
  });

  it('kills the whole process tree, not just the immediate child', async () => {
    // The immediate child spawns a grandchild that appends to a heartbeat
    // file every 50ms, named by an environment variable so neither generated
    // script needs to embed a Windows path inside JS-string escaping. If
    // only the immediate child were killed — a plain `child.kill()` rather
    // than a tree kill — the grandchild would keep appending after
    // runWithTimeout returns, an orphaned process left running exactly like
    // the hang this wrapper exists to stop.
    const heartbeat = join(sandbox, 'heartbeat.txt');
    writeFileSync(heartbeat, '');
    const spawnerScript = join(sandbox, 'spawner.cjs');
    const grandchildCode =
      "setInterval(() => require('fs').appendFileSync(process.env.HEARTBEAT_PATH, 'x'), 50);";
    writeFileSync(
      spawnerScript,
      [
        "const { spawn } = require('child_process');",
        `spawn(process.execPath, ['-e', ${JSON.stringify(grandchildCode)}], { stdio: 'ignore' });`,
        'setInterval(() => {}, 1000);',
      ].join('\n'),
    );

    const result = await runWithTimeout(process.execPath, [spawnerScript], 300, {
      env: { ...process.env, HEARTBEAT_PATH: heartbeat },
    });
    assert.equal(result.timedOut, true);

    const sizeJustAfter = readFileSync(heartbeat, 'utf8').length;
    await new Promise((resolve) => setTimeout(resolve, 500));
    const sizeLater = readFileSync(heartbeat, 'utf8').length;
    assert.equal(
      sizeLater,
      sizeJustAfter,
      `the heartbeat file grew from ${sizeJustAfter} to ${sizeLater} bytes after the kill; the grandchild is still running`,
    );
  });

  it(
    'on Windows, logs a failed taskkill instead of crashing, and logs clearly (naming the pid) ' +
      'when the child still has not reported exit by the end of the kill grace period',
    { skip: process.platform !== 'win32' && 'exercises the Windows taskkill fallback only' },
    async (t) => {
      const errorMock = t.mock.method(console, 'error');
      // A bare `taskkill` is resolved by searching `PATH`/`PATHEXT`; breaking
      // both for this process makes the kill `runWithTimeout` sends genuinely
      // fail to launch — the same as a machine where `taskkill.exe` is
      // missing or blocked, the scenario the fix exists for. The primary
      // child is unaffected: it is spawned by its full, absolute
      // `process.execPath`, which Windows resolves without consulting `PATH`
      // at all.
      const savedPath = process.env.PATH;
      const savedPathExt = process.env.PATHEXT;
      process.env.PATH = '';
      process.env.PATHEXT = '.NOPE';
      let result;
      try {
        result = await runWithTimeout(
          process.execPath,
          // Outlives the kill grace period on its own (so the "still
          // running" branch is actually reached), then exits so nothing is
          // left running once this test's assertions finish.
          ['-e', 'setTimeout(() => process.exit(0), 11_500)'],
          300,
        );
      } finally {
        process.env.PATH = savedPath;
        process.env.PATHEXT = savedPathExt;
      }
      assert.equal(result.timedOut, true);
      assert.equal(result.status, null);
      const loggedMessages = errorMock.mock.calls.map((call) => call.arguments[0]).join('\n');
      assert.match(loggedMessages, /run-with-timeout: taskkill failed to run: .*ENOENT/);
      assert.match(
        loggedMessages,
        /run-with-timeout: process \d+ did not report its exit within \d+ms of the kill; it may still be running/,
      );
    },
  );
});

describe('the CLI', () => {
  it('propagates the wrapped command\'s exit code', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '5', '--', process.execPath, '-e', 'process.exit(9)']);
    assert.equal(result.status, 9);
  });

  it('accepts the command without the optional `--` separator', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '5', process.execPath, '-e', 'process.exit(0)']);
    assert.equal(result.status, 0);
  });

  it('exits 124 and prints why when the wrapped command is killed for a timeout', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '0.3', '--', process.execPath, '-e', 'setTimeout(() => {}, 60_000)'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 124);
    assert.match(result.stderr, /did not exit within 300ms; killing it/);
  });

  it('prints usage and exits nonzero when no command is given', () => {
    const result = spawnSync(process.execPath, [SCRIPT, '5'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: node scripts\/run-with-timeout\.mjs/);
  });

  it('prints usage and exits nonzero when the timeout is not a positive number', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, 'not-a-number', '--', process.execPath, '-e', 'process.exit(0)'],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /usage: node scripts\/run-with-timeout\.mjs/);
  });

  it('says why and exits nonzero when the command cannot be started', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT, '5', '--', 'aws-langgraph-no-such-command'],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /could not start "aws-langgraph-no-such-command"/);
  });
});
