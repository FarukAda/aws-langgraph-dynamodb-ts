/**
 * Package smoke test: pack the library, install the tarball into a clean temp
 * project (without the optional @aws-sdk/client-s3 peer), and import the
 * published surface — proving the shipped artifact resolves, constructs, and
 * runs an offline code path. Requires network (npm install); run via
 * `npm run test:package-smoke`. Kept out of the default unit run.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const RUNTIME_DEPS = [
  '@aws-sdk/client-dynamodb',
  '@aws-sdk/lib-dynamodb',
  '@langchain/core',
  '@langchain/langgraph',
  '@langchain/langgraph-checkpoint',
];

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
    execSync(`npm install "${tarballPath}" ${RUNTIME_DEPS.join(' ')}`, { cwd: dir, stdio: 'ignore' });
    writeFileSync(join(dir, 'run.mjs'), SMOKE);
    const output = execSync('node run.mjs', { cwd: dir }).toString();
    assert.match(output, /SMOKE_OK/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});
