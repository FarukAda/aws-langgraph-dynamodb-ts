import type { ScanCommandInput } from '@aws-sdk/lib-dynamodb';

import type { AttributeMap } from '../../../src/shared/dynamodb/client';

/** The scalar kinds the filters this package emits compare. */
type Scalar = string | number | boolean | null | undefined;

/** A request's placeholder bindings, as the caller wrote them. */
interface Bindings {
  names: Record<string, string>;
  values: Record<string, Scalar>;
}

/** A position in the token stream, advanced as the expression is read. */
interface Cursor {
  tokens: string[];
  at: number;
}

/**
 * Split a filter expression into tokens. Parentheses and commas are punctuation
 * rather than part of a name, so they are spaced out before the split.
 */
function tokenise(expression: string): string[] {
  return expression
    .replace(/([(),])/g, ' $1 ')
    .trim()
    .split(/\s+/);
}

/**
 * What one operand denotes for `row`: a `:placeholder` from the request's
 * values, a `#alias` resolved through its names, or a bare attribute name.
 * An attribute the row does not carry reads as `undefined`, which is what
 * `attribute_exists` and `attribute_not_exists` are asking about.
 */
function operand(token: string, row: AttributeMap, bindings: Bindings): Scalar {
  if (token.startsWith(':')) return bindings.values[token];
  return row[token.startsWith('#') ? bindings.names[token] : token] as Scalar;
}

/**
 * The order DynamoDB puts two operands in: UTF-8 byte order for strings — not
 * JavaScript's `<`, which compares UTF-16 code units — and numeric order for
 * numbers. Anything else is a comparison the server would not make, so it
 * fails loudly rather than answering one.
 */
function order(left: Scalar, right: Scalar): number {
  if (typeof left === 'string' && typeof right === 'string') {
    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
  }
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  throw new Error('simulatedScan: a comparison between types DynamoDB would not order');
}

const COMPARATORS: Record<string, (ordering: number) => boolean> = {
  '<': (ordering) => ordering < 0,
  '<=': (ordering) => ordering <= 0,
  '>': (ordering) => ordering > 0,
  '>=': (ordering) => ordering >= 0,
};

/**
 * Whether `left <op> right` holds. A comparison naming an attribute the row
 * does not carry is false, as it is on the server: there is no value to order.
 */
function compares(operator: string, left: Scalar, right: Scalar): boolean {
  if (left === undefined || right === undefined) return false;
  if (operator === '=') return Object.is(left, right);
  if (operator === '<>') return !Object.is(left, right);
  const comparator = COMPARATORS[operator];
  if (comparator === undefined) throw new Error(`simulatedScan: unsupported operator ${operator}`);
  return comparator(order(left, right));
}

/** The three filter functions this package's reads use. */
function callFunction(name: string, args: Scalar[]): boolean {
  if (name === 'attribute_exists') return args[0] !== undefined;
  if (name === 'attribute_not_exists') return args[0] === undefined;
  if (name === 'begins_with') {
    return (
      typeof args[0] === 'string' && typeof args[1] === 'string' && args[0].startsWith(args[1])
    );
  }
  throw new Error(`simulatedScan: unsupported function ${name}`);
}

function parseFunction(
  name: string,
  cursor: Cursor,
  row: AttributeMap,
  bindings: Bindings,
): boolean {
  cursor.at += 1;
  const args: Scalar[] = [];
  while (cursor.tokens[cursor.at] !== ')') {
    const token = cursor.tokens[cursor.at];
    cursor.at += 1;
    if (token !== ',') args.push(operand(token, row, bindings));
  }
  cursor.at += 1;
  return callFunction(name, args);
}

function parsePrimary(cursor: Cursor, row: AttributeMap, bindings: Bindings): boolean {
  const token = cursor.tokens[cursor.at];
  cursor.at += 1;
  if (token === '(') {
    const grouped = parseOr(cursor, row, bindings);
    cursor.at += 1;
    return grouped;
  }
  if (cursor.tokens[cursor.at] === '(') return parseFunction(token, cursor, row, bindings);
  const operator = cursor.tokens[cursor.at];
  const right = cursor.tokens[cursor.at + 1];
  cursor.at += 2;
  return compares(operator, operand(token, row, bindings), operand(right, row, bindings));
}

/**
 * `AND` binds tighter than `OR`, as it does on the server. Neither side is
 * short-circuited: both have to be read for the cursor to end up past them.
 */
function parseAnd(cursor: Cursor, row: AttributeMap, bindings: Bindings): boolean {
  let value = parsePrimary(cursor, row, bindings);
  while (cursor.tokens[cursor.at] === 'AND') {
    cursor.at += 1;
    value = parsePrimary(cursor, row, bindings) && value;
  }
  return value;
}

function parseOr(cursor: Cursor, row: AttributeMap, bindings: Bindings): boolean {
  let value = parseAnd(cursor, row, bindings);
  while (cursor.tokens[cursor.at] === 'OR') {
    cursor.at += 1;
    value = parseAnd(cursor, row, bindings) || value;
  }
  return value;
}

/**
 * Whether `row` survives `input`'s `FilterExpression`. A request carrying none
 * admits every row, which is what a `Scan` without one does.
 */
export function matchesFilter(input: ScanCommandInput, row: AttributeMap): boolean {
  if (input.FilterExpression === undefined) return true;
  const bindings: Bindings = {
    names: input.ExpressionAttributeNames ?? {},
    values: (input.ExpressionAttributeValues ?? {}) as Record<string, Scalar>,
  };
  return parseOr({ tokens: tokenise(input.FilterExpression), at: 0 }, row, bindings);
}

/**
 * A table in memory answering `Scan` the way the server does: it evaluates the
 * request's own `FilterExpression` and returns only the rows that survive it.
 *
 * This is what makes "a row in another adapter's key space never reaches the
 * narrow" assertable. A mock that resolves a fixed `Items` list answers the
 * same rows whatever the filter says, so it can only ever pin the filter's
 * *text*; the server is the component that applies it, and this stands in for
 * that component. The expression is parsed from the string the code under test
 * produced, so the oracle cannot agree with it by construction.
 *
 * One page, no `ProjectionExpression` and no 1 MB cut: the subject here is
 * which rows the filter admits, and `simulatedIndex` already covers paging.
 */
export function simulatedScan(rows: readonly AttributeMap[]) {
  return (input: ScanCommandInput): { Items: AttributeMap[] } => ({
    Items: rows.filter((row) => matchesFilter(input, row)),
  });
}
