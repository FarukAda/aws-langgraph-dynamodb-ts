/**
 * Package smoke test: pack the library, install the tarball into a clean temp
 * project (without the optional @aws-sdk/client-s3 peer), and import the
 * published surface — proving the shipped artifact resolves, constructs, and
 * runs an offline code path. Requires network (npm install); run via
 * `npm run test:package-smoke`. Kept out of the default unit run.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import ts from 'typescript';

/**
 * Every required peer at its declared range, read from package.json so a new
 * peer is smoke-tested the moment it is declared and a floating `latest` never
 * breaks the smoke for reasons unrelated to the tarball. The optional S3 peer
 * is deliberately left out: the surface must import without it.
 */
const manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'));
const RUNTIME_DEPS = Object.entries(manifest.peerDependencies)
  .filter(([name]) => !manifest.peerDependenciesMeta?.[name]?.optional)
  .map(([name, range]) => `"${name}@${range}"`);

/** Type-checking the consumer needs Node types; still no @aws-sdk/client-s3. */
const TYPECHECK_DEPS = ['@types/node'];

/**
 * How long one command may run (10 minutes; an install from the registry is
 * the slow one). It is a bound on each command rather than on the test: a
 * `node:test` timeout is a timer, and a timer cannot fire while a synchronous
 * `execSync` holds the event loop, so the test-level timeout a synchronous
 * body declares never goes off. A stalled registry now fails the step that was
 * waiting on it, naming the command, instead of being cut off by the job.
 */
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;

/** `execSync`, bounded by {@link COMMAND_TIMEOUT_MS}. */
function run(command, options) {
  return execSync(command, { ...options, timeout: COMMAND_TIMEOUT_MS });
}

/**
 * The compilers the shipped declarations are checked against: the floor the
 * README's "Versioning and compatibility" section promises consumers, and the
 * newest release. Installing an unpinned `typescript` checked only whatever was
 * latest that day, so the promised floor was never exercised — and the
 * repository's own typecheck cannot stand in for it, since that compiles the
 * source with the pinned TypeScript 6/7, not the emitted `.d.ts` with a
 * consumer's compiler.
 */
const TYPECHECK_COMPILERS = ['typescript@5', 'typescript@latest'];

const OPTIONAL_PEER = '@aws-sdk/client-s3';

/**
 * A consumer that names the S3 offload types and guards a caught error the way
 * the README shows. With skipLibCheck off, tsc follows every declaration this
 * reaches; a `.d.ts` importing the optional peer would fail here with TS2307
 * pointing into node_modules. Under `--strict` a `catch` binds `unknown`, so
 * the guard compiles here only while it accepts that value with no cast. It is
 * checked twice, as `consumer.cts` and `consumer.mts`, because a CommonJS
 * consumer resolves the `require` declarations and an ES-module consumer the
 * `import` ones, and each tree must hold on its own.
 */
const CONSUMER = `
import { isDynamoDBLangGraphError } from '@farukada/aws-langgraph-dynamodb-ts';
import type { DynamoDBStoreOptions, S3OffloadConfig } from '@farukada/aws-langgraph-dynamodb-ts';

export const s3: S3OffloadConfig = { bucketName: 'b', clientConfig: { region: 'eu-west-1' } };
export const options: DynamoDBStoreOptions = { tableName: 't', clientConfig: { region: 'eu-west-1' }, s3 };

export function codeOf(run: () => void): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return isDynamoDBLangGraphError(error) ? error.code : undefined;
  }
}
`;

/** Every `.d.ts` reachable from `entry` through relative imports (extensionless or `.js`). */
function reachableDeclarations(entry) {
  const seen = new Set();
  const visit = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const info = ts.preProcessFile(readFileSync(file, 'utf8'), true, true);
    for (const imported of info.importedFiles) {
      if (!imported.fileName.startsWith('.')) continue;
      const base = resolve(dirname(file), imported.fileName).replace(/\.js$/, '');
      const target = [`${base}.d.ts`, join(base, 'index.d.ts')].find((candidate) => existsSync(candidate));
      if (target) visit(target);
    }
  };
  visit(entry);
  return [...seen];
}

/**
 * The tsc diagnostics that point at this package or at the optional peer.
 *
 * A compiler that failed without a single diagnostic — `npx` that could not
 * find it, a timeout that killed it — is not a compiler that found nothing
 * wrong, so that case throws rather than answering an empty list that would
 * pass the assertion exactly when the check did not run.
 */
function ourTypeErrors(dir) {
  const command =
    'npx tsc --noEmit --strict --skipLibCheck false --module nodenext --moduleResolution nodenext ' +
    '--target es2022 --types node consumer.cts consumer.mts';
  try {
    run(command, { cwd: dir, stdio: 'pipe' });
    return [];
  } catch (error) {
    const output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
    if (!/error TS\d+/.test(output)) {
      throw new Error(
        `tsc failed without reporting a diagnostic, so nothing was proved (${error.message}):\n${output}`,
        { cause: error },
      );
    }
    return output
      .split(/\r?\n/)
      .filter((line) => /aws-langgraph-dynamodb-ts[\\/]dist|client-s3|^consumer\.[cm]ts/.test(line));
  }
}

/**
 * The published surface through `import`. Besides the constructors, it pins
 * what the ES-module build is for: `import` resolves `dist/esm`, and a saver is
 * an instance of the `BaseCheckpointSaver` the application itself imports —
 * one copy of the peer, not a CommonJS copy beside the ES-module one. An error
 * the CommonJS copy raises is still recognised by this copy's guard, whose
 * brand is registered by name; and a missing optional peer, reached through a
 * real `import()` here, still names `s3`.
 */
const SMOKE = `
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import {
  DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory,
  DynamoDBSessionChatMessageHistory, DynamoDBFactory,
  ErrorCode, DynamoDBLangGraphError, isDynamoDBLangGraphError, redactSecrets,
} from '@farukada/aws-langgraph-dynamodb-ts';

assert.match(import.meta.resolve('@farukada/aws-langgraph-dynamodb-ts'), /\\/dist\\/esm\\/index\\.js$/);
assert.ok(new DynamoDBSaver({ tableName: 'smoke', clientConfig: { region: 'eu-west-1' } }) instanceof BaseCheckpointSaver);

for (const c of [DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory, DynamoDBSessionChatMessageHistory, DynamoDBFactory]) {
  assert.equal(typeof c, 'function');
}
assert.equal(ErrorCode.VALIDATION, 'VALIDATION');

const store = new DynamoDBStore({ tableName: 'smoke', clientConfig: { region: 'eu-west-1' } });
await assert.rejects(
  () => store.put(['bad#ns'], 'k', { v: 1 }),
  (e) => e instanceof DynamoDBLangGraphError && e.code === ErrorCode.VALIDATION,
);
assert.ok(new DynamoDBLangGraphError('x', ErrorCode.VALIDATION) instanceof DynamoDBLangGraphError);
assert.deepEqual(redactSecrets({ token: 's', keep: 'ok' }), { token: '[REDACTED]', keep: 'ok' });

const cjs = createRequire(import.meta.url)('@farukada/aws-langgraph-dynamodb-ts');
const cjsStore = new cjs.DynamoDBStore({ tableName: 'smoke', clientConfig: { region: 'eu-west-1' } });
await assert.rejects(
  () => cjsStore.put(['bad#ns'], 'k', { v: 1 }),
  (e) => !(e instanceof DynamoDBLangGraphError) && isDynamoDBLangGraphError(e) && e.code === ErrorCode.VALIDATION,
);

const offloading = new DynamoDBStore({
  tableName: 'smoke',
  clientConfig: { region: 'eu-west-1' },
  ttl: { days: 1 },
  s3: { bucketName: 'b', clientConfig: { region: 'eu-west-1' } },
});
await assert.rejects(
  () => offloading.ensureS3LifecycleRule(),
  (e) => isDynamoDBLangGraphError(e) && e.code === ErrorCode.VALIDATION && e.context.field === 's3',
);
console.log('SMOKE_OK');
`;

/**
 * The same surface through CommonJS `require`, which the exports map must serve
 * too: from `dist/cjs`, with the CommonJS copy of the peer. The CommonJS build
 * turns the optional peer's `import()` into `require`, whose
 * `MODULE_NOT_FOUND` must still name `s3`.
 */
const SMOKE_CJS = `
const assert = require('node:assert/strict');
const { BaseCheckpointSaver } = require('@langchain/langgraph-checkpoint');
const { DynamoDBSaver, DynamoDBStore, ErrorCode, DynamoDBLangGraphError } = require('@farukada/aws-langgraph-dynamodb-ts');
const { version } = require('@farukada/aws-langgraph-dynamodb-ts/package.json');
assert.match(require.resolve('@farukada/aws-langgraph-dynamodb-ts'), /[\\\\/]dist[\\\\/]cjs[\\\\/]index\\.js$/);
assert.equal(typeof DynamoDBStore, 'function');
assert.equal(typeof version, 'string');
assert.ok(new DynamoDBSaver({ tableName: 'smoke', clientConfig: { region: 'eu-west-1' } }) instanceof BaseCheckpointSaver);
const store = new DynamoDBStore({ tableName: 'smoke', clientConfig: { region: 'eu-west-1' } });
const offloading = new DynamoDBStore({
  tableName: 'smoke',
  clientConfig: { region: 'eu-west-1' },
  ttl: { days: 1 },
  s3: { bucketName: 'b', clientConfig: { region: 'eu-west-1' } },
});
(async () => {
  await assert.rejects(
    () => store.put(['bad#ns'], 'k', { v: 1 }),
    (e) => e instanceof DynamoDBLangGraphError && e.code === ErrorCode.VALIDATION,
  );
  await assert.rejects(
    () => offloading.ensureS3LifecycleRule(),
    (e) => e instanceof DynamoDBLangGraphError && e.code === ErrorCode.VALIDATION && e.context.field === 's3',
  );
  console.log('SMOKE_CJS_OK');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
`;

test('packs, installs the tarball, and imports the published surface', () => {
  const root = process.cwd();
  run('npm run build', { cwd: root, stdio: 'ignore' });
  const tarball = run('npm pack --silent', { cwd: root }).toString().trim().split(/\s+/).pop();
  const tarballPath = join(root, tarball);
  const dir = mkdtempSync(join(tmpdir(), 'lg-ddb-smoke-'));
  try {
    run('npm init -y', { cwd: dir, stdio: 'ignore' });
    run(
      `npm install "${tarballPath}" ${RUNTIME_DEPS.join(' ')} ${TYPECHECK_DEPS.join(' ')}`,
      { cwd: dir, stdio: 'ignore' },
    );
    writeFileSync(join(dir, 'run.mjs'), SMOKE);
    const output = run('node run.mjs', { cwd: dir }).toString();
    assert.match(output, /SMOKE_OK/);
    writeFileSync(join(dir, 'run.cjs'), SMOKE_CJS);
    assert.match(run('node run.cjs', { cwd: dir }).toString(), /SMOKE_CJS_OK/);
    writeFileSync(join(dir, 'consumer.cts'), CONSUMER);
    writeFileSync(join(dir, 'consumer.mts'), CONSUMER);
    for (const compiler of TYPECHECK_COMPILERS) {
      run(`npm install "${compiler}"`, { cwd: dir, stdio: 'ignore' });
      assert.deepEqual(ourTypeErrors(dir), [], `shipped declarations fail under ${compiler}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

test('the shipped declarations reachable from either index.d.ts never import the optional S3 peer', () => {
  run('npm run build', { cwd: process.cwd(), stdio: 'ignore' });
  const entries = ['dist/esm/index.d.ts', 'dist/cjs/index.d.ts'].map((entry) => resolve(entry));
  const offenders = entries.flatMap((entry) => reachableDeclarations(entry)).filter((file) =>
    ts
      .preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles.some((imported) => imported.fileName === OPTIONAL_PEER),
  );
  assert.deepEqual(offenders, []);
});
