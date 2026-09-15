import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import ts from 'typescript';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** The sections `docs/CONTRACTS.md` requires of an exported function's doc comment. */
export const REQUIRED_SECTIONS = ['Accepts:', 'Returns:', 'Throws:'] as const;

/** An exported function whose doc comment does not state the whole contract. */
export interface ContractGap {
  file: string;
  name: string;
  missing: string[];
}

/** The doc comment immediately above `node`, or '' when it has none. */
function docOf(node: ts.Node, text: string): string {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const blocks = ranges
    .filter((range) => text.slice(range.pos, range.pos + 3) === '/**')
    .map((range) => text.slice(range.pos, range.end));
  return blocks.length === 0 ? '' : blocks[blocks.length - 1];
}

/** True for a declaration the file exports. */
function isExported(node: ts.FunctionDeclaration | ts.ClassDeclaration): boolean {
  return (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

/** True for a member the class keeps to itself. */
function isPrivate(member: ts.ConstructorDeclaration | ts.MethodDeclaration): boolean {
  return (ts.getModifiers(member) ?? []).some((m) => m.kind === ts.SyntaxKind.PrivateKeyword);
}

/**
 * The gaps in one exported class: its constructor and every member a caller can
 * reach. A class is as much a contract as a function — more, since its methods
 * are the surface users actually hold.
 */
function classGaps(node: ts.ClassDeclaration, source: string, file: string): ContractGap[] {
  const name = node.name?.text ?? 'default';
  const gaps: ContractGap[] = [];
  for (const member of node.members) {
    const named =
      ts.isConstructorDeclaration(member) ||
      (ts.isMethodDeclaration(member) && member.name !== undefined);
    if (!named) continue;
    const declaration = member as ts.ConstructorDeclaration | ts.MethodDeclaration;
    if (isPrivate(declaration)) continue;
    const label = ts.isConstructorDeclaration(member)
      ? `${name}.constructor`
      : `${name}.${(member as ts.MethodDeclaration).name.getText()}`;
    const doc = docOf(member, source);
    const missing = REQUIRED_SECTIONS.filter((section) => !doc.includes(section));
    if (missing.length > 0) gaps.push({ file, name: label, missing });
  }
  return gaps;
}

/**
 * The exported functions, and the reachable members of exported classes, whose
 * doc comment omits a required section.
 *
 * A `Guarantees:` section is optional — not every function promises something
 * beyond its own result — but the other three are not: a caller cannot use a
 * function without knowing what it accepts, what it answers and what it raises.
 */
export function contractGapsIn(source: string, file = 'source.ts'): ContractGap[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const gaps: ContractGap[] = [];
  for (const node of parsed.statements) {
    if (ts.isClassDeclaration(node) && isExported(node)) {
      gaps.push(...classGaps(node, source, file));
      continue;
    }
    if (!ts.isFunctionDeclaration(node) || !isExported(node) || node.name === undefined) continue;
    const doc = docOf(node, source);
    const missing = REQUIRED_SECTIONS.filter((section) => !doc.includes(section));
    if (missing.length > 0) gaps.push({ file, name: node.name.text, missing });
  }
  return gaps;
}

/** Every exported function under `src/` whose doc comment omits a required section. */
export function contractGaps(): ContractGap[] {
  return listSourceFiles().flatMap((file) =>
    contractGapsIn(readFileSync(file, 'utf8'), relative(SRC_ROOT, file).split(sep).join('/')),
  );
}
