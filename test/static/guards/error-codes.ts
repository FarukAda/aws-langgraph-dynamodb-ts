import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import * as ts from 'typescript';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** Source file that declares the {@link ErrorCode} enum. */
const ERROR_CODE_FILE = join(SRC_ROOT, 'shared', 'errors', 'error-code.ts');

/**
 * Every member name of the enum `enumName` declared in `source`, read from the
 * AST so a stray `const FOO =` in the same file is never mistaken for one.
 */
export function enumMembersOf(source: string, enumName = 'ErrorCode'): string[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const members: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isEnumDeclaration(node) && node.name.text === enumName) {
      for (const member of node.members) {
        if (ts.isIdentifier(member.name)) members.push(member.name.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return members;
}

/** Return every member name declared in the `ErrorCode` enum. */
export function listErrorCodeMembers(): string[] {
  return enumMembersOf(readFileSync(ERROR_CODE_FILE, 'utf8'));
}

/**
 * True when `sources` reference `ErrorCode.<member>` as a whole token, so
 * `VALIDATION` is not kept alive by a reference to `VALIDATION_FAILED`.
 */
export function referencesErrorCode(member: string, sources: string): boolean {
  return new RegExp(`\\bErrorCode\\.${member}\\b`).test(sources);
}

/**
 * Return the names of `ErrorCode` members that are never referenced as
 * `ErrorCode.<MEMBER>` in any source file other than the enum declaration —
 * i.e. dead members forbidden by the no-dead-code rule.
 */
export function findDeadErrorCodes(): string[] {
  const otherSources = listSourceFiles()
    .filter((file) => file !== ERROR_CODE_FILE)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
  return listErrorCodeMembers().filter((member) => !referencesErrorCode(member, otherSources));
}
