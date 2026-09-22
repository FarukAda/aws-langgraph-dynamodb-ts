/**
 * Consumer type-check: install the packed tarball into a project pinned to an
 * older `@aws-sdk/lib-dynamodb` than this package depends on, and compile a
 * consumer that injects its own `DynamoDBDocument`.
 *
 * npm resolves that pin by giving the package its own nested, newer copy of the
 * SDK. Anything the shipped declarations type nominally against that copy is
 * unreachable for the consumer: their client is a different type with the same
 * name, and `tsc` refuses it with TS2741 naming a method only the newer copy
 * has. Runtime injection works either way, so only a compiler sees this.
 *
 * Requires network (npm install); run via `npm run test:consumer-types`. Kept
 * out of the default unit run.
 */
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const ROOT = process.cwd();
const PROJECT = join(ROOT, 'test', 'package-smoke', 'consumer-types');
const PACKAGE_NAME = '@farukada/aws-langgraph-dynamodb-ts';
const SDK = '@aws-sdk/lib-dynamodb';

const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** Every required peer at its declared range, as the package smoke test reads them. */
const RUNTIME_DEPS = Object.entries(manifest.peerDependencies)
  .filter(([name]) => !manifest.peerDependenciesMeta?.[name]?.optional)
  .map(([name, range]) => `"${name}@${range}"`);

/**
 * `--skipLibCheck` on purpose: this project asks one question — whether the
 * consumer's own client is assignable to the `client` option — and that is
 * decided in `consumer.ts`, which is checked in full either way. The shipped
 * declarations are checked against an unskipped lib check by the package smoke
 * test next to this one; repeating it here would only add ways to go red for
 * reasons that have nothing to do with the injected client.
 */
const TSC =
  'npx tsc --noEmit --strict --skipLibCheck --module nodenext --moduleResolution nodenext ' +
  '--target es2022 --types node consumer.ts';

/** The methods a `DynamoDBDocument` declaration names, one per overload set. */
function documentMembers(file) {
  const declaration = readFileSync(file, 'utf8');
  return new Set([...declaration.matchAll(/^ {4}(\w+)\(/gm)].map(([, name]) => name));
}

/** A `DynamoDBDocument.d.ts` path, given the directory the SDK copy sits in. */
function documentDeclaration(sdkRoot) {
  return join(sdkRoot, 'dist-types', 'DynamoDBDocument.d.ts');
}

/** The installed version of a package, read from the copy at `packageRoot`. */
function installedVersion(packageRoot) {
  return JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')).version;
}

/**
 * The compile, as an outcome rather than as a filtered list of diagnostics.
 *
 * A compile that fails for a reason outside `consumer.ts` — `@types/node`
 * absent from the install, a flag this compiler does not know, a file that was
 * never copied — prints no `consumer.ts` line at all, so a check that reads the
 * absence of such lines as "no errors" passes exactly when it did not run. The
 * whole output is carried back instead, and both halves are asserted: nothing
 * against the consumer, and a compiler that reached the end.
 */
function compileConsumer(dir) {
  try {
    execSync(TSC, { cwd: dir, stdio: 'pipe' });
    return { compiled: true, output: '' };
  } catch (error) {
    return { compiled: false, output: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

test("a consumer's own DocumentClient type-checks against the packed package", { timeout: 900000 }, async (t) => {
  execSync('npm run build', { cwd: ROOT, stdio: 'ignore' });
  const tarball = execSync('npm pack --silent', { cwd: ROOT }).toString().trim().split(/\s+/).pop();
  const tarballPath = join(ROOT, tarball);
  const dir = mkdtempSync(join(tmpdir(), 'lg-ddb-consumer-'));
  try {
    for (const file of ['package.json', 'consumer.ts']) {
      cpSync(join(PROJECT, file), join(dir, file));
    }
    execSync(`npm install "${tarballPath}" ${RUNTIME_DEPS.join(' ')}`, { cwd: dir, stdio: 'ignore' });

    /**
     * The positive control. A project that ends up with one deduplicated SDK
     * copy proves nothing, and would pass the assertion below no matter what
     * the `client` option is typed as — so the two copies, and the difference
     * in what they declare, are asserted before the compile is believed.
     */
    await t.test('the pin really does give the package a second, newer SDK copy', () => {
      const own = join(dir, 'node_modules', SDK);
      const nested = join(dir, 'node_modules', PACKAGE_NAME, 'node_modules', SDK);
      assert.notEqual(
        installedVersion(nested),
        installedVersion(own),
        'expected two copies of the SDK; a deduplicated tree cannot reproduce the defect',
      );
      const ours = documentMembers(documentDeclaration(own));
      const theirs = documentMembers(documentDeclaration(nested));
      const onlyNested = [...theirs].filter((member) => !ours.has(member));
      assert.notEqual(
        onlyNested.length,
        0,
        'expected the nested copy to declare a method the pinned one does not',
      );
    });

    await t.test('every documented injection point accepts it', () => {
      const { compiled, output } = compileConsumer(dir);
      const refusals = output.split(/\r?\n/).filter((line) => line.startsWith('consumer.ts'));
      assert.deepEqual(refusals, [], `the injected client was refused:\n${refusals.join('\n')}`);
      assert.ok(
        compiled,
        `tsc failed without naming consumer.ts, so nothing was proved:\n${output}`,
      );
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(tarballPath, { force: true });
  }
});
