import * as ts from 'typescript';

/** One comment in `src` that breaks the comment rules, by 1-based line. */
export interface CommentViolation {
  line: number;
  rule: 'block' | 'directive' | 'jsdoc-documents-nothing' | 'line-comment-on-declaration';
}

/** A comment that switches a checker off. */
const DIRECTIVE = /eslint-(?:disable|enable)|@ts-(?:ignore|expect-error|nocheck)/;

/** The nodes a JSDoc block documents: what TypeScript attaches one to, and what typedoc renders. */
function isDeclaration(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isClassDeclaration(node) ||
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node) ||
    ts.isVariableStatement(node) ||
    ts.isPropertyDeclaration(node) ||
    ts.isPropertySignature(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isMethodSignature(node) ||
    ts.isPropertyAssignment(node) ||
    ts.isShorthandPropertyAssignment(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isEnumMember(node) ||
    ts.isExportDeclaration(node) ||
    ts.isModuleDeclaration(node) ||
    ts.isCallSignatureDeclaration(node) ||
    ts.isIndexSignatureDeclaration(node) ||
    ts.isParameter(node)
  );
}

/** The body of a function-like node, or `undefined` for any other node. */
function bodyOf(node: ts.Node): ts.Node | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node.body;
  }
  return undefined;
}

/**
 * The start offsets of the comments that document a declaration: all of them,
 * and those whose declaration is outside every function body.
 */
function documentingComments(
  file: ts.SourceFile,
  source: string,
): { all: Set<number>; outsideBodies: Set<number> } {
  const all = new Set<number>();
  const outsideBodies = new Set<number>();
  const visit = (node: ts.Node, insideBody: boolean): void => {
    if (isDeclaration(node)) {
      for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
        all.add(range.pos);
        if (!insideBody) outsideBodies.add(range.pos);
      }
    }
    const body = bodyOf(node);
    ts.forEachChild(node, (child) => visit(child, insideBody || child === body));
  };
  visit(file, false);
  return { all, outsideBodies };
}

/**
 * Every comment in `source`, in document order, found by walking the parsed
 * tree's tokens rather than re-lexing the raw text. A bare re-scan of the
 * text has to guess whether a backtick opens a template literal or resumes
 * one after a `${}` substitution; guessing wrong swallows everything up to
 * the next backtick it finds — including every comment in between — into one
 * bogus token, and `src`'s error messages are full of such templates. The
 * parser already resolved that ambiguity correctly when it built `file`, so
 * reading trivia off its tokens instead of the text keeps every comment in
 * view.
 */
function allComments(file: ts.SourceFile, source: string): ts.CommentRange[] {
  const seen = new Set<number>();
  const ranges: ts.CommentRange[] = [];
  const visit = (node: ts.Node): void => {
    for (const range of ts.getLeadingCommentRanges(source, node.getFullStart()) ?? []) {
      if (!seen.has(range.pos)) {
        seen.add(range.pos);
        ranges.push(range);
      }
    }
    for (const child of node.getChildren(file)) visit(child);
  };
  visit(file);
  return ranges.sort((a, b) => a.pos - b.pos);
}

/**
 * Every comment in `source` that breaks the rules of decision record 23:
 *
 * - a `/** *\/` block is interface documentation, so it is either the module
 *   header — the file's first comment, with nothing before it — or the leading
 *   comment of a declaration; anywhere else it is an implementation comment
 *   and is written with `//`;
 * - a declaration outside a function body is documented with JSDoc, never
 *   with `//`, so everything typedoc and an editor show is JSDoc;
 * - a plain `/* *\/` block is refused, and so is a directive comment
 *   (`eslint-disable`, `@ts-expect-error`, ...) in any form.
 */
export function commentViolations(source: string): CommentViolation[] {
  const file = ts.createSourceFile('probe.ts', source, ts.ScriptTarget.Latest, true);
  const documenting = documentingComments(file, source);
  const violations: CommentViolation[] = [];
  let first = true;
  for (const range of allComments(file, source)) {
    const isLine = range.kind === ts.SyntaxKind.SingleLineCommentTrivia;
    const text = source.slice(range.pos, range.end);
    const isHeader = first && source.slice(0, range.pos).trim() === '';
    first = false;
    const line = source.slice(0, range.pos).split('\n').length;
    if (DIRECTIVE.test(text)) {
      violations.push({ line, rule: 'directive' });
    } else if (isLine) {
      if (documenting.outsideBodies.has(range.pos)) {
        violations.push({ line, rule: 'line-comment-on-declaration' });
      }
    } else if (!text.startsWith('/**')) {
      violations.push({ line, rule: 'block' });
    } else if (!isHeader && !documenting.all.has(range.pos)) {
      violations.push({ line, rule: 'jsdoc-documents-nothing' });
    }
  }
  return violations;
}
