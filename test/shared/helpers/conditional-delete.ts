import type { DeleteCommandInput, TransactWriteCommandInput } from '@aws-sdk/lib-dynamodb';
import { marshall } from '@aws-sdk/util-dynamodb';

import type { DocItem } from '../../../src/shared/dynamodb/types';

/** A table a conditional delete is evaluated against. */
export interface ConditionalTable {
  /** The rows still there, keyed `PK|SK`. */
  rows: Map<string, DocItem>;
  /** The handler for `mock.on(DeleteCommand).callsFake(...)`. */
  handler: (input: DeleteCommandInput) => object;
  /** Every sort key a delete was issued for, in the order it was issued. */
  issued: string[];
}

function rowKey(item: { PK?: unknown; SK?: unknown }): string {
  return `${String(item.PK)}|${String(item.SK)}`;
}

/**
 * The rejection DynamoDB answers a lost condition with: the row attached in raw
 * AttributeValue form when it is still there, and nothing at all when it is
 * gone — the two shapes the delete path has to tell apart.
 *
 * The row rides along **only** when the request asked for it. Attaching it
 * unconditionally would be the one infidelity that matters: a guard that
 * forgot `ReturnValuesOnConditionCheckFailure` would then still look like a
 * refusal carrying its row, when in production it answers without one, the
 * caller reads that as "already gone", and it counts a live row as deleted and
 * releases the objects that row still names.
 */
function rejection(input: DeleteCommandInput, row: DocItem | undefined): Error {
  const asked = input.ReturnValuesOnConditionCheckFailure === 'ALL_OLD';
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
    Item: row === undefined || !asked ? undefined : marshall(row),
  });
}

/**
 * Evaluate the condition a delete carries against the row as it is now. It
 * understands exactly the two shapes this library builds: `#pin = :pin` over a
 * top-level attribute, and `#pin.#field = :pin` over a document path. A delete
 * with no condition always holds, including against an absent row.
 */
function conditionHolds(input: DeleteCommandInput, row: DocItem | undefined): boolean {
  if (input.ConditionExpression === undefined) return true;
  if (row === undefined) return false;
  const names = input.ExpressionAttributeNames ?? {};
  const attribute = row[names['#pin']] as DocItem | string | undefined;
  const field = names['#field'];
  const observed =
    field === undefined ? attribute : (attribute as DocItem | undefined)?.[field as string];
  return observed === input.ExpressionAttributeValues?.[':pin'];
}

/**
 * A DeleteItem that evaluates its own condition against the row as it is *now*.
 *
 * A mock that resolves every delete cannot tell a pin that matches the row from
 * a pin that could never match it: both build the same request and answer the
 * same empty response, so an assertion about the *built* request passes just as
 * well against a condition that can never fire. Evaluating it here is what makes
 * "the pass deletes exactly the rows the read observed" an assertion about what
 * the pass does rather than about what it sends.
 *
 * Seed it with the rows as they stand when the deletes land, which is not
 * necessarily what the query returned — that difference is the race under test.
 */
export function conditionalTable(items: readonly DocItem[]): ConditionalTable {
  const rows = new Map(items.map((item) => [rowKey(item), item]));
  const issued: string[] = [];
  return {
    rows,
    issued,
    handler: (input: DeleteCommandInput) => {
      const key = rowKey(input.Key ?? {});
      issued.push(String(input.Key?.SK));
      const row = rows.get(key);
      if (!conditionHolds(input, row)) throw rejection(input, row);
      rows.delete(key);
      return {};
    },
  };
}

/** The one item a store delete sends, as a transaction carries it. */
type TransactDelete = NonNullable<
  NonNullable<TransactWriteCommandInput['TransactItems']>[number]['Delete']
>;

/** A table a revision-guarded, tokened delete transaction is evaluated against. */
export interface RevisionTable {
  /** The rows still there, keyed `PK|SK`. */
  rows: Map<string, DocItem>;
  /** The handler for `mock.on(TransactWriteCommand).callsFake(...)`. */
  handler: (input: TransactWriteCommandInput) => object;
  /** The request token every attempt carried, in the order the attempts were sent. */
  tokens: string[];
}

/**
 * Evaluate a `revisionGuard` condition against the row as it is now. It
 * understands the three shapes that guard builds, with one deliberate
 * divergence: `attribute_not_exists(#rev)` against an **absent** row is
 * refused here, where the service evaluates it as true and commits a no-op.
 * Both land on the same caller outcome, so no test can tell them apart - but
 * do not add a case on that cell without fixing this first, or the case will
 * be testing the fake: the row's absence,
 * the revision attribute's absence, and equality on it. An unguarded delete
 * always holds.
 */
function revisionHolds(item: TransactDelete, row: DocItem | undefined): boolean {
  const expression = item.ConditionExpression;
  if (expression === undefined) return true;
  if (expression === 'attribute_not_exists(PK)') return row === undefined;
  if (row === undefined) return false;
  const observed = row[item.ExpressionAttributeNames?.['#rev'] ?? ''];
  if (expression === 'attribute_not_exists(#rev)') return observed === undefined;
  return observed === item.ExpressionAttributeValues?.[':rev'];
}

/**
 * The cancellation DynamoDB answers a lost condition with inside a transaction:
 * one `ConditionalCheckFailed` reason, carrying the row in raw AttributeValue
 * form when it is still there and nothing at all when it is gone. Those are the
 * two shapes the delete path has to tell apart, and attaching the row when the
 * request did not ask for it would hide a guard that forgot to ask.
 */
function cancellation(item: TransactDelete, row: DocItem | undefined): Error {
  const asked = item.ReturnValuesOnConditionCheckFailure === 'ALL_OLD';
  const attached = row === undefined || !asked ? {} : { Item: marshall(row) };
  return Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: [{ Code: 'ConditionalCheckFailed', ...attached }],
  });
}

/**
 * A one-item delete transaction that evaluates its own condition against the
 * row as it is *now*, and records the token each attempt spent.
 *
 * A mock that resolves every transaction cannot tell a pin that matches the row
 * from a pin that could never match it: both build the same request and answer
 * the same empty response, so an assertion about the *built* request passes
 * just as well against a condition that can never fire. Evaluating it here is
 * what makes "the delete removes exactly the row the pre-read observed" an
 * assertion about what the call does rather than about what it sends.
 *
 * `beforeAttempt` runs with the attempt number, 1-based, and the rows as they
 * stand, which is where a test lands a competing write between two attempts.
 */
export function revisionGuardedTable(
  items: readonly DocItem[],
  beforeAttempt?: (attempt: number, rows: Map<string, DocItem>) => void,
): RevisionTable {
  const rows = new Map(items.map((item) => [rowKey(item), item]));
  const tokens: string[] = [];
  return {
    rows,
    tokens,
    handler: (input: TransactWriteCommandInput) => {
      tokens.push(String(input.ClientRequestToken));
      beforeAttempt?.(tokens.length, rows);
      const item = input.TransactItems?.[0]?.Delete as TransactDelete;
      const key = rowKey(item.Key ?? {});
      const row = rows.get(key);
      if (!revisionHolds(item, row)) throw cancellation(item, row);
      rows.delete(key);
      return {};
    },
  };
}
