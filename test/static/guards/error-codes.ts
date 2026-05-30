import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** Source file that declares the {@link ErrorCode} enum. */
const ERROR_CODE_FILE = join(SRC_ROOT, 'shared', 'errors', 'error-code.ts');

/** Matches a single enum member declaration line, capturing its name. */
const MEMBER_PATTERN = /^\s*([A-Z][A-Z0-9_]*)\s*=/gm;

/** Return every member name declared in the `ErrorCode` enum. */
export function listErrorCodeMembers(): string[] {
  const source = readFileSync(ERROR_CODE_FILE, 'utf8');
  const members: string[] = [];
  for (const match of source.matchAll(MEMBER_PATTERN)) {
    members.push(match[1]);
  }
  return members;
}

/**
 * Return the names of `ErrorCode` members that are never referenced as
 * `ErrorCode.<MEMBER>` in any source file other than the enum declaration —
 * i.e. dead members forbidden by the no-dead-code rule.
 */
export function findDeadErrorCodes(): string[] {
  const members = listErrorCodeMembers();
  const otherSources = listSourceFiles()
    .filter((file) => file !== ERROR_CODE_FILE)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  return members.filter((member) => !otherSources.includes(`ErrorCode.${member}`));
}
