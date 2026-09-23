import { readFileSync } from 'node:fs';
import { relative, sep } from 'node:path';

import * as ts from 'typescript';

import { listSourceFiles, SRC_ROOT } from './source-files';

/** One place a source file recognises an error some way other than by its code. */
export interface RecognitionSite {
  file: string;
  line: number;
  rule: string;
}

/**
 * Each compared property, the one file allowed to compare it, and why. The
 * classifier is where AWS names are read; the cancellation module is where a
 * transaction's per-item reason codes are read.
 */
const OWNED_PROPERTIES: Readonly<Record<string, string>> = {
  name: 'shared/errors/classify.ts',
  Code: 'shared/dynamodb/cancellation.ts',
};

const EQUALITY: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.EqualsEqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsEqualsToken,
  ts.SyntaxKind.EqualsEqualsToken,
  ts.SyntaxKind.ExclamationEqualsToken,
]);

/** `expression` with parentheses, casts and non-null assertions removed. */
function unwrap(expression: ts.Expression): ts.Expression {
  let current = expression;
  while (
    ts.isParenthesizedExpression(current) ||
    ts.isAsExpression(current) ||
    ts.isNonNullExpression(current) ||
    ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

/** The property name `expression` reads, or `undefined` when it reads none. */
function propertyRead(expression: ts.Expression): string | undefined {
  const target = unwrap(expression);
  if (ts.isPropertyAccessExpression(target)) return target.name.text;
  if (ts.isElementAccessExpression(target) && ts.isStringLiteralLike(target.argumentExpression)) {
    return target.argumentExpression.text;
  }
  return undefined;
}

/** Whether `expression` is `undefined` or `null`, which only tests presence. */
function isAbsence(expression: ts.Expression): boolean {
  const target = unwrap(expression);
  return (
    target.kind === ts.SyntaxKind.NullKeyword ||
    (ts.isIdentifier(target) && target.text === 'undefined')
  );
}

/** Whether `expression` is `ErrorCode.<member>`. */
function isErrorCodeMember(expression: ts.Expression): boolean {
  const target = unwrap(expression);
  return (
    ts.isPropertyAccessExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'ErrorCode'
  );
}

/** The rule a comparison of `left` with `right` breaks in `file`, if any. */
function brokenRule(left: ts.Expression, right: ts.Expression, file: string): string | undefined {
  for (const [read, other] of [
    [left, right],
    [right, left],
  ] as const) {
    const property = propertyRead(read);
    if (property === undefined || isAbsence(other)) continue;
    if (Object.hasOwn(OWNED_PROPERTIES, property) && OWNED_PROPERTIES[property] !== file) {
      return `compares .${property}; only ${OWNED_PROPERTIES[property]} may`;
    }
    if (property === 'code' && isErrorCodeMember(other) && file !== 'shared/errors/base-error.ts') {
      return 'reads .code against ErrorCode; use hasErrorCode';
    }
  }
  return undefined;
}

/**
 * Every place `source` recognises an error by name, by reason code outside the
 * cancellation module, or by an ad-hoc `.code` read. Parsed, not matched as
 * text, so a comment or a string is never counted. A value destructured first
 * (`const { name } = error`) is not seen; that is not the shape any site took.
 */
export function findRecognitionSites(source: string, file: string): RecognitionSite[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const sites: RecognitionSite[] = [];
  const report = (node: ts.Node, rule: string): void => {
    sites.push({
      file,
      line: parsed.getLineAndCharacterOfPosition(node.getStart(parsed)).line + 1,
      rule,
    });
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && EQUALITY.has(node.operatorToken.kind)) {
      const rule = brokenRule(node.left, node.right, file);
      if (rule !== undefined) report(node, rule);
    }
    if (ts.isSwitchStatement(node)) {
      const property = propertyRead(node.expression);
      if (
        property !== undefined &&
        Object.hasOwn(OWNED_PROPERTIES, property) &&
        OWNED_PROPERTIES[property] !== file
      ) {
        report(node, `switches on .${property}; only ${OWNED_PROPERTIES[property]} may`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return sites;
}

/** Every such site under `src/`, with paths relative to it. */
export function recognitionSites(): RecognitionSite[] {
  return listSourceFiles().flatMap((path) =>
    findRecognitionSites(readFileSync(path, 'utf8'), relative(SRC_ROOT, path).split(sep).join('/')),
  );
}
