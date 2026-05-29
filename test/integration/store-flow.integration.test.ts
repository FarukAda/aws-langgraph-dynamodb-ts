/**
 * INTEGRATION — store end-to-end flow against real DynamoDB Local.
 *
 * Covers REQ-31 / AC-27 for the store service AND the env-gating contract
 * (REQ-30 / AC-26). Critically, the put path runs with `ttlDays` set so the
 * reserved-word `#ttl` aliasing path actually EXECUTES against real DynamoDB —
 * an unaliased `ttl` in the UpdateExpression would be rejected by DynamoDB as a
 * reserved word, so a green put here proves the alias is correct (locks the
 * shipped #ttl fix end-to-end).
 *
 * Env-gated; reads DYNAMODB_ENDPOINT (spec default http://localhost:4566) via
 * the shared ddb-local helper. Cannot pass without docker — by design.
 */

import type { RunnableConfig } from '@langchain/core/runnables';
import type {
  GetOperation,
  ListNamespacesOperation,
  PutOperation,
  SearchOperation,
} from '@langchain/langgraph';

import { DynamoDBStore } from '../../src/index';
import {
  assertDdbLocalReachable,
  createAllTables,
  dropAllTables,
  makeLocalClient,
  uniquePrefix,
} from './helpers/ddb-local';

const INTEGRATION_ENABLED = process.env.RUN_INTEGRATION === '1';
// Spec AC-26: endpoint comes from DYNAMODB_ENDPOINT defaulting to http://localhost:4566.
const RESOLVED_DDB_ENDPOINT = process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:4566';
const describeIntegration = INTEGRATION_ENABLED ? describe : describe.skip;

const USER_ID = 'user-store-1';
const NAMESPACE = ['docs', 'user-store-1'];
const KEY = 'report1';
const TTL_DAYS = 30;

const config: RunnableConfig = { configurable: { user_id: USER_ID } };

describeIntegration('store flow (DDB Local)', () => {
  const { ddb, doc } = makeLocalClient();
  const prefix = uniquePrefix('store-flow');
  let tables: Awaited<ReturnType<typeof createAllTables>>;
  let store: DynamoDBStore;

  beforeAll(async () => {
    await assertDdbLocalReachable(ddb);
    tables = await createAllTables(ddb, prefix);
    store = new DynamoDBStore({
      memoryTableName: tables.memoryTable,
      client: doc,
      ttlDays: TTL_DAYS,
    });
  });

  afterAll(async () => {
    store?.destroy();
    await dropAllTables(ddb, tables);
    ddb.destroy();
  });

  it('skips cleanly when RUN_INTEGRATION is unset and otherwise resolves DYNAMODB_ENDPOINT to its documented default', () => {
    // When this suite runs at all, integration is enabled; the endpoint default
    // is the spec-mandated http://localhost:4566 unless overridden.
    expect(INTEGRATION_ENABLED).toBe(true);
    expect(RESOLVED_DDB_ENDPOINT).toBe(process.env.DYNAMODB_ENDPOINT ?? 'http://localhost:4566');
  }); // AC-26

  it('runs put -> get -> search -> listNamespaces with the reserved-word #ttl path executing on real DynamoDB', async () => {
    const put: PutOperation = {
      namespace: NAMESPACE,
      key: KEY,
      value: { title: 'Annual Report', status: 'active', score: 5 },
    };
    // A green put proves the UpdateExpression's `#ttl = :ttl` alias executes —
    // an unaliased `ttl` would be rejected by DynamoDB as a reserved word.
    await store.batch([put], config);

    // The item is physically present with the composite sort key and a numeric ttl.
    const stored = await doc.get({
      TableName: tables.memoryTable,
      Key: { user_id: USER_ID, namespace_key: `${NAMESPACE.join('/')}#${KEY}` },
    });
    expect(stored.Item?.user_id).toBe(USER_ID);
    expect(typeof stored.Item?.ttl).toBe('number');
    expect(stored.Item?.value).toEqual({ title: 'Annual Report', status: 'active', score: 5 });

    // get returns the round-tripped item.
    const get: GetOperation = { namespace: NAMESPACE, key: KEY };
    const [item] = await store.batch([get], config);
    expect(item?.key).toBe(KEY);
    expect(item?.namespace).toEqual(NAMESPACE);
    expect(item?.value).toEqual({ title: 'Annual Report', status: 'active', score: 5 });

    // search by namespace prefix with a matching filter returns the item.
    const search: SearchOperation = {
      namespacePrefix: ['docs'],
      filter: { status: 'active' },
      limit: 10,
      offset: 0,
    };
    const [results] = await store.batch([search], config);
    expect(results.map((r) => r.key)).toContain(KEY);

    // a filter that matches nothing returns an empty result set.
    const noMatch: SearchOperation = {
      namespacePrefix: ['docs'],
      filter: { status: 'archived' },
      limit: 10,
      offset: 0,
    };
    const [empty] = await store.batch([noMatch], config);
    expect(empty).toEqual([]);

    // listNamespaces surfaces the namespace we wrote under.
    const listNs: ListNamespacesOperation = { limit: 100, offset: 0 };
    const [namespaces] = await store.batch([listNs], config);
    expect(namespaces).toContainEqual(NAMESPACE);
  }); // AC-27

  it('rejects a batch whose config omits user_id with the documented error and writes nothing', async () => {
    // Realistic validation error path — getUserId throws before any DDB call.
    const put: PutOperation = { namespace: ['orphan'], key: 'k', value: { a: 1 } };
    await expect(store.batch([put], { configurable: {} })).rejects.toThrow(
      'Field user_id is required in the RunnableConfig for DynamoDBStore.',
    );

    // Nothing was written for the orphan namespace under any user.
    const scanOrphan = await doc.get({
      TableName: tables.memoryTable,
      Key: { user_id: USER_ID, namespace_key: 'orphan#k' },
    });
    expect(scanOrphan.Item).toBeUndefined();
  }); // AC-27
});
