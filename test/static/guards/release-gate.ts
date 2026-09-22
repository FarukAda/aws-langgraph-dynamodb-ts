import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { SRC_ROOT } from './source-files';

const WORKFLOWS = resolve(SRC_ROOT, '..', '.github', 'workflows');

/**
 * A deliberately narrow reader for the two shapes this guard needs, rather than
 * a YAML dependency: the only parser resolvable here is an old `js-yaml` that
 * `npm audit` already reports, and adding one to satisfy a test would widen the
 * dependency surface of a package that ships none. Everything it does not
 * recognise throws, so a workflow it cannot read fails the test instead of
 * quietly producing a shorter list.
 */
function read(file: string): string[] {
  return readFileSync(resolve(WORKFLOWS, file), 'utf8').split('\n');
}

/** One job of a workflow: its id, the name template, and its matrix axes. */
interface Job {
  id: string;
  name: string;
  matrix: Record<string, string[]>;
}

/** `['a', 'b']` or `[a, b]` — the only matrix form this repository uses. */
function inlineList(raw: string, axis: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) {
    throw new Error(`matrix axis ${axis} is not an inline list; teach this guard about it`);
  }
  return trimmed
    .slice(1, -1)
    .split(',')
    .map((entry) => entry.trim().replace(/^['"]|['"]$/g, ''))
    .filter((entry) => entry.length > 0);
}

/** The jobs of a workflow, with their matrix axes resolved. */
function jobsOf(file: string): Job[] {
  const lines = read(file);
  const jobs: Job[] = [];
  let current: Job | undefined;
  let inMatrix = false;
  /** Only the `jobs:` block holds jobs; `on:` has keys at the same indent. */
  let inJobs = false;
  for (const line of lines) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S/.test(line)) inJobs = false;
    if (!inJobs) continue;
    const job = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (job) {
      if (current) jobs.push(current);
      current = { id: job[1], name: job[1], matrix: {} };
      inMatrix = false;
      continue;
    }
    if (!current) continue;
    const name = /^ {4}name:\s*(.+?)\s*$/.exec(line);
    if (name) {
      current.name = name[1].replace(/^['"]|['"]$/g, '');
      continue;
    }
    if (/^ {6}matrix:\s*$/.test(line)) {
      inMatrix = true;
      continue;
    }
    if (inMatrix) {
      const axis = /^ {8}([A-Za-z][\w-]*):\s*(.+?)\s*$/.exec(line);
      if (axis) current.matrix[axis[1]] = inlineList(axis[2], axis[1]);
      else if (/^ {0,7}\S/.test(line)) inMatrix = false;
    }
  }
  if (current) jobs.push(current);
  return jobs;
}

/** Every combination of a job's matrix axes. */
function combinations(matrix: Record<string, string[]>): Record<string, string>[] {
  let out: Record<string, string>[] = [{}];
  for (const [axis, values] of Object.entries(matrix)) {
    out = out.flatMap((base) => values.map((value) => ({ ...base, [axis]: value })));
  }
  return out;
}

/** Substitute `${{ matrix.x }}`; anything left unexpanded is an error. */
function renderName(template: string, values: Record<string, string>): string {
  const rendered = template.replace(
    /\$\{\{\s*matrix\.([A-Za-z0-9_-]+)\s*\}\}/g,
    (_match, axis: string) => {
      const value = values[axis];
      if (value === undefined) throw new Error(`job name references unknown matrix axis ${axis}`);
      return value;
    },
  );
  if (rendered.includes('${{')) {
    throw new Error(`job name still holds an expression after expansion: ${rendered}`);
  }
  return rendered;
}

/**
 * Every check-run name the workflows the release waits on produce for one
 * tagged commit, with each matrix job expanded the way GitHub names its runs:
 * `ci.yml`, and `integration-live.yml`, the live-AWS tier that runs on the same
 * tag push.
 */
export function ciCheckNames(): string[] {
  return ['ci.yml', 'integration-live.yml'].flatMap((file) =>
    jobsOf(file).flatMap((job) =>
      combinations(job.matrix).map((values) => renderName(job.name, values)),
    ),
  );
}

/** The check names the release gate refuses to publish without. */
export function requiredCheckNames(): string[] {
  return JSON.parse(
    readFileSync(resolve(SRC_ROOT, '..', 'scripts', 'required-checks.json'), 'utf8'),
  ) as string[];
}

/**
 * The lines of each job in a workflow, keyed by job id: everything from the
 * job's key to the next job's, so a permission or a step can be attributed to
 * the job that holds it.
 */
export function jobBodies(file: string): Record<string, string[]> {
  const bodies: Record<string, string[]> = {};
  let inJobs = false;
  let current: string[] | undefined;
  for (const line of read(file)) {
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (inJobs && /^\S/.test(line)) inJobs = false;
    if (!inJobs) continue;
    const job = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line);
    if (job) {
      current = [];
      bodies[job[1]] = current;
      continue;
    }
    current?.push(line);
  }
  return bodies;
}

/** The workflow's top-level `permissions:` line, as written. */
export function topLevelPermissions(file: string): string | undefined {
  return read(file).find((line) => /^permissions:/.test(line));
}
