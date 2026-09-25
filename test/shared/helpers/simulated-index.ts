import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import type { AttributeMap } from '../../../src/shared/dynamodb/client';

/**
 * Is `key` below `bound` in the order DynamoDB applies to a string sort key —
 * the order of the UTF-8 bytes, which is not JavaScript's `<`?
 *
 * Written with `Buffer.compare` rather than by calling the comparator the
 * merge uses, so that this oracle cannot agree with the code under test by
 * construction: a test asserting a page boundary has to be able to disagree
 * with it.
 */
function belowBound(key: string, bound: string): boolean {
  return Buffer.compare(Buffer.from(key, 'utf8'), Buffer.from(bound, 'utf8')) < 0;
}

/**
 * A recency index in memory, answering `Query` the way DynamoDB does at a page
 * boundary.
 *
 * `shards` maps each index partition to its rows, newest first. `cut` stands in
 * for the 1 MB limit: a page holds at most that many rows whatever `Limit` asks
 * for, and it carries a `LastEvaluatedKey` whenever rows past it remain. One
 * number cuts every partition alike; a map gives each partition its own. The
 * key is honoured as `ExclusiveStartKey`, and `:before` as the cursor bound,
 * both in the server's own byte order.
 */
export function simulatedIndex(
  shards: Record<string, AttributeMap[]>,
  cuts: number | Record<string, number>,
) {
  return (input: QueryCommandInput) => {
    const partition = input.ExpressionAttributeValues?.[':pk'] as string;
    const cut = typeof cuts === 'number' ? cuts : cuts[partition];
    const before = input.ExpressionAttributeValues?.[':before'] as string | undefined;
    const after = input.ExclusiveStartKey?.gsi1sk as string | undefined;
    const rows = (shards[partition] ?? []).filter(
      (row) =>
        (before === undefined || belowBound(row.gsi1sk as string, before)) &&
        (after === undefined || belowBound(row.gsi1sk as string, after)),
    );
    const page = rows.slice(0, Math.min(input.Limit ?? rows.length, cut));
    const last = page[page.length - 1];
    return {
      Items: page,
      ...(rows.length > page.length ? { LastEvaluatedKey: { gsi1sk: last.gsi1sk } } : {}),
    };
  };
}

/**
 * One session row of the index, on `partition`, whose sort key is second
 * `second` of a fixed minute: a larger number is a newer row.
 */
export function indexRow(partition: string, second: number, id = `s${second}`): AttributeMap {
  const at = `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;
  return {
    PK: `SESS#${id}`,
    SK: 'HISTORY#SESSION',
    sessionId: id,
    messageCount: 1,
    createdAt: at,
    updatedAt: at,
    gsi1pk: partition,
    gsi1sk: `${at}#${id}`,
  };
}

/** Rows on `partition` for each second in `seconds`, which must be given newest first. */
export function indexRows(partition: string, seconds: number[]): AttributeMap[] {
  return seconds.map((second) => indexRow(partition, second));
}
