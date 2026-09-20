import type { DeleteCommandInput } from '@aws-sdk/lib-dynamodb';
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
 */
function rejection(row: DocItem | undefined): Error {
  return Object.assign(new Error('The conditional request failed'), {
    name: 'ConditionalCheckFailedException',
    Item: row === undefined ? undefined : marshall(row),
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
      if (!conditionHolds(input, row)) throw rejection(row);
      rows.delete(key);
      return {};
    },
  };
}
