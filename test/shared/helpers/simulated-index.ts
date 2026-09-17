import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';

import type { DocItem } from '../../../src/shared/dynamodb/types';

/**
 * A recency index in memory, answering `Query` the way DynamoDB does at a page
 * boundary.
 *
 * `shards` maps each index partition to its rows, newest first. `cut` stands in
 * for the 1 MB limit: a page holds at most that many rows whatever `Limit` asks
 * for, and it carries a `LastEvaluatedKey` whenever rows past it remain. The
 * key is honoured as `ExclusiveStartKey`, and `:before` as the cursor bound.
 */
export function simulatedIndex(shards: Record<string, DocItem[]>, cut: number) {
  return (input: QueryCommandInput) => {
    const partition = input.ExpressionAttributeValues?.[':pk'] as string;
    const before = input.ExpressionAttributeValues?.[':before'] as string | undefined;
    const after = input.ExclusiveStartKey?.gsi1sk as string | undefined;
    const rows = (shards[partition] ?? []).filter(
      (row) =>
        (before === undefined || (row.gsi1sk as string) < before) &&
        (after === undefined || (row.gsi1sk as string) < after),
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
export function indexRow(partition: string, second: number, id = `s${second}`): DocItem {
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
export function indexRows(partition: string, seconds: number[]): DocItem[] {
  return seconds.map((second) => indexRow(partition, second));
}
