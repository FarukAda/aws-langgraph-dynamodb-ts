import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';

import { SRC_ROOT } from './source-files';

/** One plan-process reference found in committed source, by file and 1-based line. */
export interface PlanReferenceHit {
  file: string;
  line: number;
  text: string;
}

/** The repository root, one level above {@link SRC_ROOT}. */
const REPO_ROOT = resolve(SRC_ROOT, '..');

/**
 * This guard's own two files, excluded from the real-tree scan because they
 * necessarily contain every pattern below, as the test data that proves the
 * guard recognises it.
 */
const GUARD_OWN_FILES = new Set([
  'test/static/guards/plan-references.ts',
  'test/static/plan-references.test.ts',
]);

/**
 * `Ruling`/`Rulings`, case-insensitive, optionally followed by a space, then
 * a number — "Ruling 13", "ruling 13", "Ruling13", "Rulings 13 and 14".
 */
const RULING = /\bRulings?\s*\d+\b/i;

/**
 * "fix round", case-insensitive, with a space, hyphen or underscore between
 * the two words — "fix round", "fix-round", "Fix_Round".
 */
const FIX_ROUND = /fix[ _-]round/i;

/**
 * "brief" used as a noun naming a plan document: "task brief", "see brief",
 * "per brief", the possessive "brief's", or "the brief". The adjective ("a
 * brief moment") is never one of these phrasings, so it is left alone.
 */
const BRIEF_NOUN = /\btask brief\b|\bsee brief\b|\bper brief\b|\bbrief's\b|\bthe brief\b/i;

/** A plan task id, e.g. `P2.3` or the two-digit `P2.10`. */
const PLAN_TASK_ID = /\bP\d+\.\d+\b/;

/**
 * A numbered plan task: capital `Task` followed by a space, hyphen or
 * underscore then digits ("Task 9", "Task-3", "Task_3"), or lowercase
 * `task` followed by a space then digits ("task 9"). Lowercase `task`
 * followed by a hyphen or underscore ("task-1", "task_1") is deliberately
 * left unmatched: those are LangGraph task ids inside sort keys and
 * fixtures, not a reference to this repository's own plan tasks.
 */
const NUMBERED_TASK = /\bTask[ _-]\d+\b|\btask \d+\b/;

/** A design-decision id `D1`-`D9`. Checked only on a line {@link isCommentLine} accepts. */
const DESIGN_DECISION = /\bD[1-9]\b/;

/**
 * Known limits, left unwidened on purpose:
 *
 * - A reordered "round N fix" is not caught. No plan has ever produced that
 *   ordering, and a pattern loose enough to catch it would also fire on
 *   `test/unit/shared/dynamodb/drain-unprocessed.test.ts`'s legitimate
 *   BatchWriteItem retry-round prose ("Round 1: …", "round 2 …"), which
 *   names a retry round, not a plan-review round.
 * - A design-decision id in a trailing comment (`foo(); // D1`) is not
 *   caught. Only a line whose trimmed text *opens* a comment is scanned
 *   ({@link isCommentLine}), by design: catching a trailing comment would
 *   need real comment-range parsing, the way `guards/comments.ts` does it,
 *   not the cheap line-prefix check this guard uses.
 */
const ALWAYS_CHECKED = [RULING, FIX_ROUND, BRIEF_NOUN, PLAN_TASK_ID, NUMBERED_TASK];

/**
 * True when `line`'s trimmed text opens a comment: `*` (a JSDoc or block
 * continuation line), `/*` (a block comment's first line) or `//` (a line
 * comment). This is the scoping rule for {@link DESIGN_DECISION}: it must
 * flag a design decision cited in prose, never an id used as ordinary test
 * data such as a checkpoint id string.
 */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//');
}

/** Every plan-process reference in `source`, attributed to `file`. */
export function planReferencesIn(source: string, file: string): PlanReferenceHit[] {
  const hits: PlanReferenceHit[] = [];
  const lines = source.split('\n');
  for (const [index, line] of lines.entries()) {
    const patterns = isCommentLine(line) ? [...ALWAYS_CHECKED, DESIGN_DECISION] : ALWAYS_CHECKED;
    for (const pattern of patterns) {
      const match = pattern.exec(line);
      if (match !== null) hits.push({ file, line: index + 1, text: match[0] });
    }
  }
  return hits;
}

/** Every file under `dir`, recursively, whose extension is in `extensions`. */
function listRecursive(dir: string, extensions: readonly string[]): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listRecursive(full, extensions));
    else if (extensions.includes(extname(entry.name))) out.push(full);
  }
  return out;
}

/** Every file under `dir`, recursively, whatever its extension — or none, as `CODEOWNERS` has. */
function listEveryFile(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    return entry.isDirectory() ? listEveryFile(full) : [full];
  });
}

/** Every file directly inside `dir` (not recursive) whose extension is in `extensions`. */
function listShallow(dir: string, extensions: readonly string[]): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extensions.includes(extname(entry.name)))
    .map((entry) => join(dir, entry.name));
}

/**
 * Every file under the repository's scanned trees, relative to
 * {@link REPO_ROOT} with forward slashes: every `.ts` file under `src`, every
 * `.ts` or `.mjs` file under `test`, and every `.mjs` file directly inside
 * `scripts` and `examples`. Shared by every guard that walks the same file
 * set; each applies its own exclusions on top.
 */
export function allScannableFiles(): string[] {
  const absolute = [
    ...listRecursive(SRC_ROOT, ['.ts']),
    ...listRecursive(resolve(REPO_ROOT, 'test'), ['.ts', '.mjs']),
    ...listShallow(resolve(REPO_ROOT, 'scripts'), ['.mjs']),
    ...listShallow(resolve(REPO_ROOT, 'examples'), ['.mjs']),
  ];
  return absolute.map((path) => relative(REPO_ROOT, path).split(sep).join('/'));
}

/** Extensions of the hand-edited files directly in the repository root. */
const ROOT_DOC_EXTENSIONS: readonly string[] = ['.md', '.json', '.yml', '.yaml'];

/**
 * Root files a person does not edit: npm writes the lockfile, and a hit in it
 * could only be fixed by regenerating it.
 */
const GENERATED_ROOT_FILES: ReadonlySet<string> = new Set(['package-lock.json']);

/** Whether a file directly in the repository root is one a person edits. */
function isHandEditedRootFile(name: string): boolean {
  if (GENERATED_ROOT_FILES.has(name)) return false;
  return name.endsWith('.config.ts') || ROOT_DOC_EXTENSIONS.includes(extname(name));
}

/**
 * The hand-edited files a reader meets beside the code, relative to
 * {@link REPO_ROOT} with forward slashes: every `.md`, `.json`, `.yml` or
 * `.yaml` file and every `*.config.ts` directly in the repository root —
 * derived from the directory, so a new root document is covered without being
 * listed — except the npm lockfile, and every file under `.github`. The
 * generated `docs/api` is not among them: it is rebuilt from the `src`
 * comments, which are scanned already, and a hit there could only be fixed at
 * its source.
 */
export function handEditedDocFiles(): string[] {
  const rootFiles = readdirSync(REPO_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isHandEditedRootFile(entry.name))
    .map((entry) => join(REPO_ROOT, entry.name));
  const absolute = [...rootFiles, ...listEveryFile(resolve(REPO_ROOT, '.github'))];
  return absolute.map((path) => relative(REPO_ROOT, path).split(sep).join('/'));
}

/**
 * {@link allScannableFiles} and {@link handEditedDocFiles}, excluding
 * {@link GUARD_OWN_FILES}: this guard's own real-tree scan must skip the two
 * files that necessarily contain every pattern it looks for.
 */
function scannedFilePaths(): string[] {
  return [...allScannableFiles(), ...handEditedDocFiles()].filter(
    (path) => !GUARD_OWN_FILES.has(path),
  );
}

/** Every plan-process reference found across the real tree's scanned files. */
export function planReferences(): PlanReferenceHit[] {
  return scannedFilePaths().flatMap((path) =>
    planReferencesIn(readFileSync(resolve(REPO_ROOT, path), 'utf8'), path),
  );
}
