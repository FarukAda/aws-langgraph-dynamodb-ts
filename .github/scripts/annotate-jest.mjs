/**
 * Turn a jest `--json` report into GitHub check-run annotations and a job
 * summary, so a failing DynamoDB-Local test is readable from the checks API
 * and the run page without opening (or having access to) the raw job log.
 *
 *   node .github/scripts/annotate-jest.mjs <jest-json-report> [<label>]
 *
 * Emits one `::error` workflow command per failed assertion (GitHub shows at
 * most ten per step, so the first ten failures are annotated and the summary
 * lists them all) and never fails itself: a missing or unreadable report
 * means jest crashed before writing one, which the test step already reported.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { relative } from 'node:path';

const [reportPath, label = 'jest'] = process.argv.slice(2);
const MAX_ANNOTATIONS = 10;
const MAX_MESSAGE_CHARS = 1500;

if (!reportPath || !existsSync(reportPath)) {
  console.log(`::warning title=${label}::no jest report at ${reportPath ?? '(none)'}; the test step crashed before writing one`);
  process.exit(0);
}

const report = JSON.parse(readFileSync(reportPath, 'utf8'));
const failures = [];
for (const file of report.testResults ?? []) {
  const path = relative(process.cwd(), file.name).replace(/\\/g, '/');
  if (file.status === 'failed' && (file.assertionResults ?? []).every((a) => a.status !== 'failed')) {
    failures.push({ path, name: '(suite failed to run)', message: file.message ?? '' });
  }
  for (const assertion of file.assertionResults ?? []) {
    if (assertion.status !== 'failed') continue;
    failures.push({
      path,
      name: assertion.fullName,
      message: (assertion.failureMessages ?? []).join('\n'),
    });
  }
}

/** Workflow-command values must escape newlines and the two command delimiters. */
const encode = (text) =>
  text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A').replace(/:/g, '%3A').replace(/,/g, '%2C');
const strip = (text) => text.replace(/\[[0-9;]*m/g, '');

/** GitHub keeps ten error annotations per step, so the first one names every failure. */
if (failures.length > 0) {
  const roll = failures.map((failure) => `${failure.path} › ${failure.name}`).join('\n');
  console.log(
    `::error title=${encode(`${label}: ${failures.length} failing test(s)`)}::${encode(roll.slice(0, 6000))}`,
  );
}
for (const failure of failures.slice(0, MAX_ANNOTATIONS - 1)) {
  const message = strip(failure.message).slice(0, MAX_MESSAGE_CHARS);
  console.log(
    `::error file=${failure.path},line=1,title=${encode(`${label}: ${failure.name}`)}::${encode(message)}`,
  );
}

const summary = [
  `## ${label}: ${failures.length} failing test${failures.length === 1 ? '' : 's'}`,
  '',
  ...failures.flatMap((failure) => [
    `### ${failure.path} — ${failure.name}`,
    '',
    '```',
    strip(failure.message).slice(0, 4000),
    '```',
    '',
  ]),
].join('\n');
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`);
console.log(`${label}: ${failures.length} failing test(s) annotated`);
