import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

/**
 * End to end: runs the unit tier's own configuration against the fixtures in
 * `test/shared/fixtures/strict-async` in a separate jest process, so the
 * warnings come from real Node core code on the real `process`, the way they
 * would from a leak in this library. A listener attached inside a test file
 * never sees them; only the test environment, which runs outside the sandbox,
 * does.
 */
interface AssertionResult {
  title: string;
  status: string;
  failureMessages: string[];
}

interface JsonReport {
  testResults: { assertionResults: AssertionResult[] }[];
}

const repoRoot = join(__dirname, '..', '..', '..');

function runFixtures(): Map<string, AssertionResult> {
  const run = spawnSync(
    process.execPath,
    [
      require.resolve('jest/bin/jest'),
      '--config',
      join(repoRoot, 'jest.config.mjs'),
      '--testMatch',
      '<rootDir>/test/shared/fixtures/strict-async/*.fixture.ts',
      '--coverage=false',
      '--runInBand',
      '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  const report = JSON.parse(run.stdout) as JsonReport;
  const byTitle = new Map<string, AssertionResult>();
  for (const file of report.testResults) {
    for (const result of file.assertionResults) byTitle.set(result.title, result);
  }
  return byTitle;
}

describe('the strict-async test environment', () => {
  let results: Map<string, AssertionResult>;

  beforeAll(() => {
    results = runFixtures();
  }, 120_000);

  it('fails a test that triggers a DeprecationWarning, naming it', () => {
    const result = results.get('calls a deprecated API');
    expect(result?.status).toBe('failed');
    expect(result?.failureMessages.join('\n')).toMatch(
      /Node warning during this test:\n.*DeprecationWarning: fixture deprecation/,
    );
  });

  it('fails a test that triggers a MaxListenersExceededWarning, naming it', () => {
    const result = results.get('adds one listener too many');
    expect(result?.status).toBe('failed');
    expect(result?.failureMessages.join('\n')).toMatch(
      /Node warning during this test:\n.*MaxListenersExceededWarning/,
    );
  });

  it('leaves an unhandled rejection to jest, which already fails the test', () => {
    const result = results.get('leaves a rejection unhandled');
    expect(result?.status).toBe('failed');
    expect(result?.failureMessages.join('\n')).toMatch(/fixture rejection/);
  });

  it('passes a test that triggers neither', () => {
    expect(results.get('does nothing wrong')?.status).toBe('passed');
  });
});
