/**
 * The CI annotator, run as a workflow step runs it, over a jest `--json`
 * report written for the test.
 *
 * A workflow command is `::error <properties>::<data>`, and GitHub unescapes
 * the two halves differently: a property has `%`, CR, LF, `:` and `,`
 * escaped, because `:` and `,` delimit properties; the data after `::` has
 * only `%`, CR and LF, and a `%3A` or `%2C` left in it is shown as written.
 * Every assertion message carries a colon (`Expected: …`), so escaping the
 * data as a property rendered every annotation with `%3A` in it.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../../.github/scripts/annotate-jest.mjs', import.meta.url));

/** Run the annotator over `report`, with the step summary going to a file. */
function annotate(report, label = 'integration') {
  const dir = mkdtempSync(join(tmpdir(), 'annotate-jest-'));
  const reportPath = join(dir, 'jest.json');
  const summaryPath = join(dir, 'summary.md');
  writeFileSync(reportPath, JSON.stringify(report));
  writeFileSync(summaryPath, '');
  const result = spawnSync(process.execPath, [SCRIPT, reportPath, label], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
    timeout: 20_000,
  });
  return { ...result, summary: readFileSync(summaryPath, 'utf8') };
}

const failing = (message) => ({
  testResults: [
    {
      name: join(process.cwd(), 'test', 'integration', 'x.integration.test.ts'),
      status: 'failed',
      assertionResults: [
        { status: 'passed', fullName: 'passes', failureMessages: [] },
        { status: 'failed', fullName: 'fails: a, b', failureMessages: [message] },
      ],
    },
  ],
});

describe('annotate-jest', () => {
  it('escapes the annotation data for %, CR and LF only, keeping its colons and commas', () => {
    const { stdout, status } = annotate(failing('Expected: 1, got 2\r\n100% wrong'));
    assert.equal(status, 0);
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('::error file='));
    assert.ok(line, 'one annotation per failed assertion');
    const data = line.slice(line.indexOf('::', 2) + 2);
    assert.equal(data, 'Expected: 1, got 2%0D%0A100%25 wrong');
  });

  it('escapes the properties for the delimiters too, so a title holding ":" or "," stays one property', () => {
    const { stdout } = annotate(failing('boom'));
    const line = stdout.split('\n').find((candidate) => candidate.startsWith('::error file='));
    const properties = line.slice('::error '.length, line.indexOf('::', 2));
    assert.match(properties, /title=integration%3A fails%3A a%2C b/);
    assert.doesNotMatch(properties, /fails: a, b/);
  });

  it('leads with one annotation naming every failure, and writes the summary', () => {
    const { stdout, summary } = annotate(failing('boom'));
    const [first] = stdout.split('\n');
    assert.match(first, /^::error title=integration%3A 1 failing test\(s\)::/);
    assert.match(first, /::test\/integration\/x\.integration\.test\.ts › fails: a, b$/);
    assert.match(summary, /## integration: 1 failing test\n/);
    assert.match(summary, /### test\/integration\/x\.integration\.test\.ts — fails: a, b/);
  });

  it('exits 0 with a warning when there is no report', () => {
    const result = spawnSync(process.execPath, [SCRIPT, join(tmpdir(), 'no-such-report.json')], {
      encoding: 'utf8',
      timeout: 20_000,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /^::warning title=jest::no jest report/);
  });
});
