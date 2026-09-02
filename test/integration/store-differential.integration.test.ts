import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  type BaseStore,
  InMemoryStore,
  type SearchOperation,
} from '@langchain/langgraph-checkpoint';

import { DynamoDBStore } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';

const tableName = 'store-differential-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let dynamo: DynamoDBStore;
const memory = new InMemoryStore();

/**
 * Three roots, three depths. Keys and namespaces are inserted in sorted order
 * so the reference store (insertion order) and DynamoDB (key order) page the
 * same way; every other comparison is order-insensitive.
 */
const FIXTURES = [
  { namespace: ['a'], key: 'k1', value: { kind: 'note', n: 1, tags: ['x'], meta: { level: 1 } } },
  {
    namespace: ['a', 'b'],
    key: 'k2',
    value: { kind: 'doc', n: 5, tags: ['y'], meta: { level: 2 } },
  },
  {
    namespace: ['a', 'b', 'c'],
    key: 'k3',
    value: { kind: 'note', n: 10, tags: ['x', 'y'], meta: { level: 3 } },
  },
  { namespace: ['b'], key: 'k4', value: { kind: 'doc', n: 7, tags: [], meta: { level: 1 } } },
  {
    namespace: ['b', 'c'],
    key: 'k5',
    value: { kind: 'note', n: 3, tags: ['z'], meta: { level: 2 } },
  },
  { namespace: ['c'], key: 'k6', value: { kind: 'other', n: 8, tags: ['x'], meta: { level: 1 } } },
  {
    namespace: ['c', 'd', 'e'],
    key: 'k7',
    value: { kind: 'note', n: 2, tags: ['y'], meta: { level: 3 } },
  },
];

type SearchOptions = Pick<SearchOperation, 'filter' | 'limit' | 'offset'>;
interface ListOptions {
  prefix?: string[];
  suffix?: string[];
  maxDepth?: number;
  limit?: number;
  offset?: number;
}

const SEARCHES: SearchOptions[] = [
  {},
  { filter: { kind: 'note' } },
  { filter: { n: { $gt: 4 } } },
  { filter: { n: { $gte: 5, $lt: 10 } } },
  { filter: { n: { $lte: 3 } } },
  { filter: { kind: { $ne: 'note' } } },
  { filter: { kind: { $in: ['doc', 'other'] } } },
  { filter: { kind: { $nin: ['doc'] } } },
  { filter: { 'meta.level': 2 } },
];

const PREFIXES = [['a'], ['a', 'b'], ['b'], []];

/** Result order is not part of the contract (insertion order there, key order here), so a page is compared by size and membership. */
const PAGED_SEARCHES: SearchOptions[] = [
  { limit: 3 },
  { offset: 2, limit: 3 },
  { offset: 1, limit: 1 },
];

const LISTINGS: ListOptions[] = [
  {},
  { prefix: ['a'] },
  { suffix: ['c'] },
  { prefix: ['a'], maxDepth: 2 },
  { maxDepth: 1 },
  { prefix: ['c'], suffix: ['e'] },
];

const PAGED_LISTINGS: ListOptions[] = [{ limit: 3 }, { offset: 2, limit: 3 }];

interface Digest {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
}

/** Items reduced to what both stores must agree on, in a fixed order. */
const digest = (
  items: readonly { namespace: string[]; key: string; value: Record<string, unknown> }[],
): Digest[] =>
  items
    .map(({ namespace, key, value }) => ({ namespace, key, value }))
    .sort((left, right) => left.key.localeCompare(right.key));

const joined = (namespaces: string[][]): string[] => namespaces.map((ns) => ns.join('/')).sort();

async function seed(store: BaseStore): Promise<void> {
  for (const fixture of FIXTURES) await store.put(fixture.namespace, fixture.key, fixture.value);
}

beforeAll(async () => {
  await createTable(admin, tableName);
  dynamo = new DynamoDBStore({ tableName, clientConfig: DDB_LOCAL_CONFIG });
  await seed(dynamo);
  await seed(memory);
});

afterAll(async () => {
  dynamo.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

describe('DynamoDBStore matches InMemoryStore (TEST-06)', () => {
  it('returns the same items from get', async () => {
    for (const fixture of FIXTURES) {
      const [ours, theirs] = await Promise.all([
        dynamo.get(fixture.namespace, fixture.key),
        memory.get(fixture.namespace, fixture.key),
      ]);
      expect(ours?.value).toEqual(theirs?.value);
    }
    expect(await dynamo.get(['a'], 'missing')).toBeNull();
  });

  it.each(SEARCHES.map((options) => [JSON.stringify(options), options] as const))(
    'search %s agrees for every prefix',
    async (_label, options) => {
      for (const prefix of PREFIXES) {
        const [ours, theirs] = await Promise.all([
          dynamo.search(prefix, options),
          memory.search(prefix, options),
        ]);
        expect(digest(ours)).toEqual(digest(theirs));
      }
    },
  );

  it.each(PAGED_SEARCHES.map((options) => [JSON.stringify(options), options] as const))(
    'search %s pages to a window of the same size drawn from the same items',
    async (_label, options) => {
      for (const prefix of PREFIXES) {
        const [ours, theirs, all] = await Promise.all([
          dynamo.search(prefix, options),
          memory.search(prefix, options),
          memory.search(prefix, { limit: 100 }),
        ]);
        expect(ours).toHaveLength(theirs.length);
        const keys = new Set(all.map((item) => item.key));
        for (const item of ours) expect(keys.has(item.key)).toBe(true);
      }
    },
  );

  it.each(LISTINGS.map((options) => [JSON.stringify(options), options] as const))(
    'listNamespaces %s agrees as a set',
    async (_label, options) => {
      const [ours, theirs] = await Promise.all([
        dynamo.listNamespaces(options),
        memory.listNamespaces(options),
      ]);
      expect(joined(ours)).toEqual(joined(theirs));
    },
  );

  it.each(PAGED_LISTINGS.map((options) => [JSON.stringify(options), options] as const))(
    'listNamespaces %s pages to the same window',
    async (_label, options) => {
      const [ours, theirs] = await Promise.all([
        dynamo.listNamespaces(options),
        memory.listNamespaces(options),
      ]);
      expect(joined(ours)).toEqual(joined(theirs));
    },
  );

  it('diverges only where documented: range operators compare type-strictly', async () => {
    await dynamo.put(['div'], 'k', { n: '10' });
    await memory.put(['div'], 'k', { n: '10' });
    const filter = { n: { $gt: 5 } };
    expect((await memory.search(['div'], { filter })).map((item) => item.key)).toEqual(['k']);
    expect(await dynamo.search(['div'], { filter })).toEqual([]);
  });
});
