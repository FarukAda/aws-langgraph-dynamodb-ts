/**
 * INTEGRATION — store pagination edges (gap-class G, AC-28 / REQ-32).
 *
 * Exercises the three pagination hazards against real DDB-Local:
 *
 *   1. An empty page that still carries a `LastEvaluatedKey` MUST keep the loop
 *      paginating. DynamoDB applies `Limit` BEFORE `FilterExpression`, so a small
 *      `limit` over a corpus where most rows are filtered out yields pages with
 *      zero matching items but a non-null `LastEvaluatedKey`. The implementation
 *      breaks only on `!lastEvaluatedKey`, never on an empty `Items` page — this
 *      test fails if that regresses.
 *   2. A page exactly at `Limit`: a non-filtered search with `limit === N` over
 *      exactly N items returns all N and terminates.
 *   3. A filter eliminating every page until the last: the single matching item
 *      lives behind several all-filtered pages and is still returned.
 *
 * `ExclusiveStartKey` round-trips implicitly: correctness of the final result set
 * proves the cursor was threaded back into each subsequent page.
 *
 * Env-gated by `jest.integration.config.ts`; requires DDB-Local. `beforeAll`
 * fails fast with guidance when Docker is down.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { SearchOperation } from '@langchain/langgraph';

import { DynamoDBStore } from '../../src';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';

const USER = 'page-user';
const NS = ['notes'];

describe('store pagination edges (integration)', () => {
  let ddb: DynamoDBClient;
  let doc: DynamoDBDocument;
  let tables: { memoryTable: string } & Record<string, string>;
  let store: DynamoDBStore;

  beforeAll(async () => {
    ({ ddb, doc } = makeLocalClient());
    await assertDdbLocalReachable(ddb);
    tables = await createAllTables(ddb, uniquePrefix('store-pagination'));
    store = new DynamoDBStore({ client: doc, memoryTableName: tables.memoryTable });
  });

  afterAll(async () => {
    store?.destroy();
    if (tables) await dropAllTables(ddb, tables);
    ddb?.destroy();
  });

  const config = { configurable: { user_id: USER } };

  async function seed(count: number, markLastAs: string): Promise<void> {
    // Write `count` items; all but the final one carry kind:"other", the last
    // carries kind:"<markLastAs>" so a filter on kind eliminates everything but it.
    for (let i = 0; i < count; i += 1) {
      const isLast = i === count - 1;
      await store.batch(
        [
          {
            namespace: NS,
            key: `k-${String(i).padStart(4, '0')}`,
            value: { kind: isLast ? markLastAs : 'other', i },
          },
        ],
        config,
      );
    }
  }

  it('keeps paginating across empty (fully filtered) pages that still carry a LastEvaluatedKey', async () => {
    const marker = 'target-A';
    await seed(25, marker);

    // limit:1 forces DynamoDB to page one (pre-filter) item at a time; the filter
    // drops 24 of 25 rows, so the matching item is found only by continuing past
    // many empty pages. The loop must NOT stop on the first empty page.
    const op: SearchOperation = {
      namespacePrefix: NS,
      filter: { kind: marker },
      limit: 1,
      offset: 0,
    };
    const [results] = await store.batch([op], config);

    expect(results).toHaveLength(1);
    expect(results[0]?.key).toBe('k-0024');
    expect(results[0]?.value).toMatchObject({ kind: marker, i: 24 });
  }); // AC-28

  it('returns a full page exactly at Limit and stops without an extra page', async () => {
    // Fresh namespace to isolate the exact-Limit assertion from the prior seed.
    const exactNs = ['exact'];
    for (let i = 0; i < 5; i += 1) {
      await store.batch([{ namespace: exactNs, key: `e-${i}`, value: { i } }], config);
    }

    const op: SearchOperation = { namespacePrefix: exactNs, limit: 5, offset: 0 };
    const [results] = await store.batch([op], config);

    // Exactly Limit items returned, no more, no fewer — the page boundary lands
    // precisely on the corpus size.
    expect(results).toHaveLength(5);
    const keys = results.map((r) => r.key).sort();
    expect(keys).toEqual(['e-0', 'e-1', 'e-2', 'e-3', 'e-4']);
  }); // AC-28

  it('finds the single match behind many all-filtered pages (filter eliminates every page until the last)', async () => {
    const lateNs = ['late'];
    const marker = 'needle';
    for (let i = 0; i < 30; i += 1) {
      const isLast = i === 29;
      await store.batch(
        [
          {
            namespace: lateNs,
            key: `n-${String(i).padStart(4, '0')}`,
            value: { kind: isLast ? marker : 'haystack', i },
          },
        ],
        config,
      );
    }

    const op: SearchOperation = {
      namespacePrefix: lateNs,
      filter: { kind: marker },
      limit: 10,
      offset: 0,
    };
    const [results] = await store.batch([op], config);

    expect(results).toHaveLength(1);
    expect(results[0]?.key).toBe('n-0029');
  }); // AC-28

  it('throws "Field user_id is required" rather than silently paginating without a partition key', async () => {
    // Realistic ERROR path: a misconfigured RunnableConfig must abort before any
    // query/pagination is attempted.
    const op: SearchOperation = { namespacePrefix: NS, limit: 5, offset: 0 };
    await expect(store.batch([op], { configurable: {} })).rejects.toThrow(
      'Field user_id is required in the RunnableConfig for DynamoDBStore.',
    );
  }); // AC-28
});
