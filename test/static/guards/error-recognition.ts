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

/** Whether `property` is owned, and read outside the one file allowed to read it in `file`. */
function ownedElsewhere(property: string, file: string): boolean {
  return Object.hasOwn(OWNED_PROPERTIES, property) && OWNED_PROPERTIES[property] !== file;
}

/** Whether `.code` may be read ad hoc against `ErrorCode` in `file` (only the base class may). */
function codeOwnedElsewhere(file: string): boolean {
  return file !== 'shared/errors/base-error.ts';
}

/** The rule a `switch` on `discriminant` breaks in `file`, if any. */
function brokenSwitchRule(node: ts.SwitchStatement, file: string): string | undefined {
  const property = propertyRead(node.expression);
  if (property === undefined) return undefined;
  if (ownedElsewhere(property, file)) {
    return `switches on .${property}; only ${OWNED_PROPERTIES[property]} may`;
  }
  const comparesToErrorCode = node.caseBlock.clauses.some(
    (clause) => ts.isCaseClause(clause) && isErrorCodeMember(clause.expression),
  );
  if (property === 'code' && comparesToErrorCode && codeOwnedElsewhere(file)) {
    return 'switches on .code against ErrorCode; use hasErrorCode';
  }
  return undefined;
}

/** Method names whose argument is tested for membership in, or a match against, the receiver. */
const MEMBERSHIP_METHODS: ReadonlySet<string> = new Set(['includes', 'indexOf', 'has', 'test']);

/** The elements a membership receiver tests against, when they are statically visible. */
function membershipElements(receiver: ts.Expression): readonly ts.Expression[] | undefined {
  const target = unwrap(receiver);
  if (ts.isArrayLiteralExpression(target)) return target.elements;
  if (
    ts.isNewExpression(target) &&
    ts.isIdentifier(target.expression) &&
    target.expression.text === 'Set' &&
    target.arguments?.length === 1
  ) {
    const sole = unwrap(target.arguments[0]);
    if (ts.isArrayLiteralExpression(sole)) return sole.elements;
  }
  return undefined;
}

/**
 * The rule a membership test (`array.includes(x)`, `array.indexOf(x)`,
 * `set.has(x)`, `regex.test(x)`) breaks in `file`, if any — the array-form
 * bypass of the same comparisons {@link brokenRule} already refuses.
 */
function brokenMembershipRule(node: ts.CallExpression, file: string): string | undefined {
  const callee = unwrap(node.expression);
  if (!ts.isPropertyAccessExpression(callee) || !MEMBERSHIP_METHODS.has(callee.name.text)) {
    return undefined;
  }
  for (const argument of node.arguments) {
    const property = propertyRead(argument);
    if (property === undefined) continue;
    if (ownedElsewhere(property, file)) {
      return `tests .${property} via .${callee.name.text}(); only ${OWNED_PROPERTIES[property]} may`;
    }
    if (property !== 'code' || !codeOwnedElsewhere(file)) continue;
    const elements = membershipElements(callee.expression) ?? [];
    if (elements.some((element) => isErrorCodeMember(element))) {
      return `tests .code via .${callee.name.text}() against ErrorCode; use hasErrorCode`;
    }
  }
  return undefined;
}

/**
 * Every place `source` recognises an error by name, by reason code outside the
 * cancellation module, or by an ad-hoc `.code` read — an equality, a `switch`,
 * or a membership test (`.includes`, `.indexOf`, `.has`, `.test`) all count.
 * Parsed, not matched as text, so a comment or a string is never counted. A
 * value destructured first (`const { name } = error`) is not seen; that is
 * not the shape any site took.
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
      const rule = brokenSwitchRule(node, file);
      if (rule !== undefined) report(node, rule);
    }
    if (ts.isCallExpression(node)) {
      const rule = brokenMembershipRule(node, file);
      if (rule !== undefined) report(node, rule);
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
