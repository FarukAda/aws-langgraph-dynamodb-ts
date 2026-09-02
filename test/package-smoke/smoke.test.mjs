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

/** Type-checking the consumer needs a compiler and Node types; still no @aws-sdk/client-s3. */
const TYPECHECK_DEPS = ['typescript', '@types/node'];

const OPTIONAL_PEER = '@aws-sdk/client-s3';

/**
 * A consumer that names the S3 offload types. With skipLibCheck off, tsc
 * follows every declaration this reaches; a `.d.ts` importing the optional
 * peer would fail here with TS2307 pointing into node_modules.
 */
const CONSUMER = `
import type { DynamoDBStoreOptions, S3OffloadConfig } from '@farukada/aws-langgraph-dynamodb-ts';

export const s3: S3OffloadConfig = { bucketName: 'b', clientConfig: { region: 'eu-west-1' } };
export const options: DynamoDBStoreOptions = { tableName: 't', clientConfig: { region: 'eu-west-1' }, s3 };
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

/** The tsc diagnostics that point at this package or at the optional peer. */
function ourTypeErrors(dir) {
  const command =
    'npx tsc --noEmit --strict --skipLibCheck false --module nodenext --moduleResolution nodenext ' +
    '--target es2022 --types node consumer.ts';
  try {
    execSync(command, { cwd: dir, stdio: 'pipe' });
    return [];
  } catch (error) {
    const output = error.stdout ? error.stdout.toString() : '';
    return output
      .split(/\r?\n/)
      .filter((line) => /aws-langgraph-dynamodb-ts[\\/]dist|client-s3|^consumer\.ts/.test(line));
  }
}

const SMOKE = `
import assert from 'node:assert/strict';
import {
  DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory,
  DynamoDBSessionChatMessageHistory, DynamoDBFactory,
  ErrorCode, DynamoDBLangGraphError, ValidationError, redactSecrets,
} from '@farukada/aws-langgraph-dynamodb-ts';

for (const c of [DynamoDBSaver, DynamoDBStore, DynamoDBChatMessageHistory, DynamoDBSessionChatMessageHistory, DynamoDBFactory]) {
  assert.equal(typeof c, 'function');
}
assert.equal(ErrorCode.VALIDATION, 'VALIDATION');

const store = new DynamoDBStore({ tableName: 'smoke', clientConfig: { region: 'eu-west-1' } });
await assert.rejects(
  () => store.put(['bad#ns'], 'k', { v: 1 }),
  (e) => e instanceof DynamoDBLangGraphError && e.code === ErrorCode.VALIDATION,
);
assert.ok(new ValidationError('x') instanceof DynamoDBLangGraphError);
assert.deepEqual(redactSecrets({ token: 's', keep: 'ok' }), { token: '[REDACTED]', keep: 'ok' });
console.log('SMOKE_OK');
`;

test('packs, installs the tarball, and imports the published surface', { timeout: 600000 }, () => {
  const root = process.cwd();
  execSync('npm run build', { cwd: root, stdio: 'ignore' });
  const tarball = execSync('npm pack --silent', { cwd: root }).toString().trim().split(/\s+/).pop();
  const tarballPath = join(root, tarball);
  const dir = mkdtempSync(join(tmpdir(), 'lg-ddb-smoke-'));
  try {
    execSync('npm init -y', { cwd: dir, stdio: 'ignore' });
    execSync(
      `npm install "${tarballPath}" ${RUNTIME_DEPS.join(' ')} ${TYPECHECK_DEPS.join(' ')}`,
      { cwd: dir, stdio: 'ignore' },
    );
    writeFileSync(join(dir, 'run.mjs'), SMOKE);
    const output = execSync('node run.mjs', { cwd: dir }).toString();
    assert.match(output, /SMOKE_OK/);
    writeFileSync(join(dir, 'consumer.ts'), CONSUMER);
    assert.deepEqual(ourTypeErrors(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});

test('the shipped declarations reachable from index.d.ts never import the optional S3 peer', { timeout: 600000 }, () => {
  execSync('npm run build', { cwd: process.cwd(), stdio: 'ignore' });
  const offenders = reachableDeclarations(resolve('dist/index.d.ts')).filter((file) =>
    ts
      .preProcessFile(readFileSync(file, 'utf8'), true, true)
      .importedFiles.some((imported) => imported.fileName === OPTIONAL_PEER),
  );
  assert.deepEqual(offenders, []);
});
