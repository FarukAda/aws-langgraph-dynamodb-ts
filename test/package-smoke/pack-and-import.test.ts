/**
 * PACKAGE-SMOKE: pack the library, install the tarball into a throwaway temp
 * project, import it by its PUBLISHED package name, and run a representative
 * flow against DDB Local (REQ-37 / gap I / AC-33).
 *
 * Why this exists: unit/integration tests import from `src/`, so they cannot
 * catch packaging mistakes. This test exercises the *shipped artifact* and
 * fails on:
 *   - `files` omitting `dist/` (tarball ships no build output)
 *   - a broken `exports`/`main`/`types` map (import resolves to nothing)
 *   - a runtime dependency declared only as devDependency (missing at install)
 *
 * This test SHELLS OUT (npm pack + npm install + a child node process) and is
 * therefore deliberately excluded from the default `npm test` run: the default
 * jest config does not match `test/package-smoke/**`. It additionally self-gates
 * on RUN_PACKAGE_SMOKE / RUN_INTEGRATION so it only executes under the
 * integration/release config, never on a developer's plain `npm test`.
 *
 * It needs a long jest timeout — `npm install` of a tarball + transitive deps
 * routinely takes well over a minute on a cold cache. The integration config's
 * 120s testTimeout covers this; an explicit per-test timeout is set below as a
 * belt-and-braces guard if this file is run under a tighter config.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { DDB_LOCAL_ENDPOINT } from '../integration/helpers/ddb-local';

const RUN = !!process.env.RUN_PACKAGE_SMOKE || !!process.env.RUN_INTEGRATION;
const describeSmoke = RUN ? describe : describe.skip;

const REPO_ROOT = resolve(__dirname, '..', '..');
const PKG = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
  name: string;
  version: string;
};
const PKG_NAME = PKG.name; // @farukada/aws-langgraph-dynamodb-ts

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  });
}

describeSmoke('package-smoke: pack, install by name, and run a representative flow', () => {
  let workDir: string;
  let tarballPath: string;

  beforeAll(() => {
    // Build so `dist/` exists, then pack from the repo root.
    run(NPM, ['run', 'build'], REPO_ROOT);
    workDir = mkdtempSync(join(tmpdir(), 'pkg-smoke-'));
    // `npm pack --json` prints the produced tarball filename.
    const out = run(NPM, ['pack', '--json', '--pack-destination', workDir], REPO_ROOT);
    const parsed = JSON.parse(out) as Array<{ filename: string }>;
    tarballPath = join(workDir, parsed[0].filename);
  }, 600_000);

  afterAll(() => {
    if (workDir && existsSync(workDir)) rmSync(workDir, { recursive: true, force: true });
  });

  it('ships dist/ via `files` and a working `exports` map: a fresh install can import every entry-point export by package name', () => {
    // The tarball must actually contain the built entry point — this is the
    // `files`/`dist` guard.
    const listing = run(NPM, ['pack', '--dry-run', '--json'], REPO_ROOT);
    const entries = JSON.parse(listing) as Array<{ files: Array<{ path: string }> }>;
    const paths = entries[0].files.map((f) => f.path);
    expect(paths).toContain('dist/index.js');
    expect(paths).toContain('dist/index.d.ts');

    // Install the packed tarball into the throwaway project.
    writeFileSync(
      join(workDir, 'package.json'),
      JSON.stringify({ name: 'smoke-consumer', version: '0.0.0', private: true }, null, 2),
    );
    run(NPM, ['install', tarballPath, '--no-audit', '--no-fund'], workDir);

    // Import BY PACKAGE NAME (not a relative path) in a child process so the
    // `exports`/`main` map and peer-dep resolution are exercised exactly as a
    // consumer would hit them.
    const probe = join(workDir, 'probe.cjs');
    writeFileSync(
      probe,
      [
        `const pkg = require(${JSON.stringify(PKG_NAME)});`,
        // A removed/renamed export, or a broken exports map, fails here.
        `const expected = ['DynamoDBSaver','DynamoDBStore','DynamoDBChatMessageHistory','DynamoDBFactory','setGlobalLogger','getLogger','resetLogger','BatchWriteIncompleteError'];`,
        `const missing = expected.filter((n) => typeof pkg[n] === 'undefined');`,
        `if (missing.length) { console.error('MISSING_EXPORTS:' + missing.join(',')); process.exit(3); }`,
        `process.stdout.write('OK');`,
      ].join('\n'),
    );
    const result = run(process.execPath, [probe], workDir);
    expect(result).toBe('OK');
  }, 600_000); // AC-33

  it('the installed package runs a representative checkpointer flow (construct, put, getTuple) against DDB Local', () => {
    // Requires the tarball already installed by the prior test's workDir.
    run(NPM, ['install', tarballPath, '--no-audit', '--no-fund'], workDir);

    const flow = join(workDir, 'flow.cjs');
    writeFileSync(
      flow,
      [
        `const { DynamoDBSaver } = require(${JSON.stringify(PKG_NAME)});`,
        `(async () => {`,
        `  const cfgClient = { endpoint: ${JSON.stringify(DDB_LOCAL_ENDPOINT)}, region: 'local', credentials: { accessKeyId: 'local', secretAccessKey: 'local' } };`,
        `  const saver = new DynamoDBSaver({`,
        `    checkpointsTableName: ${JSON.stringify(`${tableBase()}-checkpoints`)},`,
        `    writesTableName: ${JSON.stringify(`${tableBase()}-writes`)},`,
        `    clientConfig: cfgClient,`,
        `  });`,
        `  const cfg = { configurable: { thread_id: 'smoke-thread', checkpoint_ns: '' } };`,
        `  const checkpoint = { v: 1, id: 'smoke-ckpt', ts: '2023-11-14T22:13:20.000Z', channel_values: { messages: 'hi' }, channel_versions: {}, versions_seen: {}, pending_sends: [] };`,
        `  const next = await saver.put(cfg, checkpoint, { source: 'input', step: 0, parents: {} }, {});`,
        `  const tuple = await saver.getTuple({ configurable: { thread_id: 'smoke-thread', checkpoint_ns: '', checkpoint_id: next.configurable.checkpoint_id } });`,
        `  if (!tuple || tuple.checkpoint.id !== 'smoke-ckpt') { console.error('FLOW_FAIL'); process.exit(4); }`,
        `  saver.destroy();`,
        `  process.stdout.write('FLOW_OK');`,
        `})().catch((e) => { console.error('FLOW_ERR:' + (e && e.message)); process.exit(5); });`,
      ].join('\n'),
    );

    // The table must exist for the flow to round-trip; the smoke flow assumes
    // the integration harness created it (RUN_INTEGRATION implies DDB Local +
    // tables). We assert the published artifact runs end-to-end and persists.
    const result = run(process.execPath, [flow], workDir);
    expect(result).toBe('FLOW_OK');
  }, 600_000); // AC-33
});

/**
 * Stable table base for the smoke flow. The integration harness owns table
 * lifecycle; the smoke flow reuses a fixed name created by the package-smoke CI
 * job's setup so the published artifact can round-trip a real write/read.
 */
function tableBase(): string {
  return process.env.PACKAGE_SMOKE_TABLE_PREFIX ?? 'pkg-smoke';
}
