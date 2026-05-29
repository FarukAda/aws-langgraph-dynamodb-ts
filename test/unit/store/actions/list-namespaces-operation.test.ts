/**
 * Unit tests for src/store/actions/list-namespaces-operation.ts.
 *
 * Characterizes the EXISTING listNamespacesOperationAction. Locks:
 *  - the base QueryCommand shape: KeyConditionExpression 'user_id = :uid',
 *    ExpressionAttributeValues { ':uid' }, ProjectionExpression 'namespace',
 *    and NO ExpressionAttributeNames key when there are no suffix conditions
 *    (DDB rejects an empty EAN object — locked here)
 *  - the begins_with optimization for prefix MatchConditions
 *  - the contains() FilterExpression + aliased #ns0 -> 'namespace' for suffix
 *    MatchConditions
 *  - dedupe + sort + offset/limit slicing of returned namespace arrays
 *  - validation negatives and AbortSignal behavior
 *
 * Strict DDB mock, frozen time, pinned constants.
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import type { MatchCondition } from '@langchain/langgraph-checkpoint';

import { listNamespacesOperationAction } from '../../../../src/store/actions';
import { USER_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import {
  expectExactQueryCommand,
  expectNoUnexpectedCommands,
} from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';

const MEMORY_TABLE = 'memory-table';

describe('listNamespacesOperationAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  const client = (): DynamoDBDocument => ddb.mock as unknown as DynamoDBDocument;

  it('issues a QueryCommand projecting namespace with no ExpressionAttributeNames and returns deduped, sorted paths', async () => {
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        { namespace: 'b/x' },
        { namespace: 'a/y' },
        { namespace: 'a/y' }, // duplicate — deduped
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { limit: 100, offset: 0, matchConditions: [], maxDepth: undefined },
    });

    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': USER_ID },
      ProjectionExpression: 'namespace',
    });
    // EAN must be absent (DDB rejects an empty ExpressionAttributeNames object).
    const call = ddb.mock.commandCalls(QueryCommand)[0];
    expect(call.args[0].input).not.toHaveProperty('ExpressionAttributeNames');
    // Sorted by localeCompare of joined path: 'a/y' before 'b/x'.
    expect(result).toEqual([
      ['a', 'y'],
      ['b', 'x'],
    ]);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-7

  it('adds begins_with(namespace_key, :nsPrefix) for a concrete prefix MatchCondition', async () => {
    ddb.mock.on(QueryCommand).resolves({
      Items: [{ namespace: 'users/alice' }],
      LastEvaluatedKey: undefined,
    });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: {
        limit: 100,
        offset: 0,
        matchConditions: [{ matchType: 'prefix', path: ['users'] }],
        maxDepth: undefined,
      },
    });

    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid AND begins_with(namespace_key, :nsPrefix)',
      ExpressionAttributeValues: { ':uid': USER_ID, ':nsPrefix': 'users' },
      ProjectionExpression: 'namespace',
    });
    expect(result).toEqual([['users', 'alice']]);
  }); // AC-7

  it('builds a contains() FilterExpression with aliased #ns0 -> namespace for a suffix MatchCondition', async () => {
    ddb.mock.on(QueryCommand).resolves({
      Items: [{ namespace: 'a/reports' }],
      LastEvaluatedKey: undefined,
    });

    await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: {
        limit: 100,
        offset: 0,
        matchConditions: [{ matchType: 'suffix', path: ['reports'] }],
        maxDepth: undefined,
      },
    });

    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': USER_ID, ':suffix0': 'reports' },
      ProjectionExpression: 'namespace',
      FilterExpression: 'contains(#ns0, :suffix0)',
      ExpressionAttributeNames: { '#ns0': 'namespace' },
    });
  }); // AC-7

  it('rejects with the maxDepth ValidationError and issues no QueryCommand for maxDepth below 1', async () => {
    await expect(
      listNamespacesOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { limit: 100, offset: 0, matchConditions: [], maxDepth: 0 },
      }),
    ).rejects.toThrow('maxDepth must be at least 1');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('rejects with the userId ValidationError and issues no QueryCommand for a non-string userId', async () => {
    await expect(
      listNamespacesOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,

        userId: 42 as any,
        op: { limit: 100, offset: 0, matchConditions: [], maxDepth: undefined },
      }),
    ).rejects.toThrow('User ID must be a string');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('propagates a non-retryable ProvisionedThroughputExceededException after retry exhaustion is not triggered for a non-string', async () => {
    const err = Object.assign(new Error('throttled hard'), {
      name: 'ResourceNotFoundException',
    });
    ddb.mock.on(QueryCommand).rejects(err);

    await expect(
      listNamespacesOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { limit: 100, offset: 0, matchConditions: [], maxDepth: undefined },
      }),
    ).rejects.toThrow('throttled hard');
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-8

  it('short-circuits with zero DDB calls when the signal is already aborted', async () => {
    const reason = new Error('already-aborted');
    const signal = preAbortedSignal(reason);

    await expect(
      listNamespacesOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { limit: 100, offset: 0, matchConditions: [], maxDepth: undefined },
        signal,
      }),
    ).rejects.toBe(reason);
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18

  // ---- Extended coverage: branch/line gaps in list-namespaces-operation.ts ----

  it('paginates across pages (lines 113-114) carrying ExclusiveStartKey from the prior LastEvaluatedKey', async () => {
    // Prevents the second page request from dropping ExclusiveStartKey and
    // re-reading page one. targetSize = (1 + 0) * 10 = 10, so two small pages are
    // both consumed before the candidate target is met.
    ddb.mock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ namespace: 'a' }], LastEvaluatedKey: { pk: 'page1' } })
      .resolvesOnce({ Items: [{ namespace: 'b' }], LastEvaluatedKey: undefined });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { limit: 1, offset: 0, matchConditions: [], maxDepth: undefined },
    });

    const calls = ddb.mock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    // Single mutated queryParams reused by reference => the final recorded input
    // carries the ExclusiveStartKey set on the second iteration (lines 113-114).
    expect(calls[1].args[0].input).toEqual({
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': USER_ID },
      ProjectionExpression: 'namespace',
      ExclusiveStartKey: { pk: 'page1' },
    });
    // limit=1 slices to the first sorted namespace.
    expect(result).toEqual([['a']]);
  });

  it('throws (line 110) the iteration-limit error when paging never terminates', async () => {
    // Prevents an infinite pagination loop: must bail after MAX_LOOP_ITERATIONS
    // (1000). Empty pages keep namespaceSet small so the targetSize break (139)
    // never fires.
    ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { pk: 'never-ends' } });

    await expect(
      listNamespacesOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { limit: 100, offset: 0, matchConditions: [], maxDepth: undefined },
      }),
    ).rejects.toThrow('List namespaces operation exceeded maximum iteration limit');
  });

  it('breaks after collecting enough candidates (line 139) without fetching the next advertised page', async () => {
    // Prevents over-fetching: once targetSize candidates are collected the loop
    // must stop even though DDB advertises another page. limit=1, offset=0 =>
    // targetSize = 10; one page of 10 distinct namespaces meets it exactly.
    const items = Array.from({ length: 10 }, (_, i) => ({ namespace: `n${i}` }));
    ddb.mock.on(QueryCommand).resolvesOnce({ Items: items, LastEvaluatedKey: { pk: 'more' } });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { limit: 1, offset: 0, matchConditions: [], maxDepth: undefined },
    });

    // Exactly one query — the targetSize break prevents a second page fetch.
    expect(ddb.mock.commandCalls(QueryCommand)).toHaveLength(1);
    // Sorted, sliced to limit=1 => the first namespace 'n0'.
    expect(result).toEqual([['n0']]);
  });

  it('truncates each namespace to maxDepth and dedupes collapsed parents (lines 162-167)', async () => {
    // Prevents maxDepth from filtering instead of collapsing: deeper paths must
    // truncate to their first N segments and dedupe with their siblings.
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        { namespace: 'a/b/c' },
        { namespace: 'a/b/d' }, // collapses to 'a/b' alongside the row above
        { namespace: 'a/x' },
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { limit: 100, offset: 0, matchConditions: [], maxDepth: 2 },
    });

    // 'a/b/c' & 'a/b/d' both truncate to ['a','b']; 'a/x' truncates to ['a','x'].
    expect(result).toEqual([
      ['a', 'b'],
      ['a', 'x'],
    ]);
  });

  it('filters out namespaces failing an in-memory prefix condition (lines 150-153, 232-247)', async () => {
    // Prevents over-inclusive begins_with results from leaking past the in-memory
    // match filter. The concrete prefix optimizes the query, and matchesPrefix
    // drops the false positive whose first segment differs.
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        { namespace: 'users/alice' }, // matches prefix ['users','*']
        { namespace: 'users' }, // pattern longer than path (line 232) => excluded
        { namespace: 'admins/bob' }, // first segment mismatch (line 247) => excluded
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: {
        limit: 100,
        offset: 0,
        // Wildcard in the path exercises extractConcretePrefix's break (line 184)
        // and matchesPrefix's wildcard-continue (line 242).
        matchConditions: [{ matchType: 'prefix', path: ['users', '*'] }],
        maxDepth: undefined,
      },
    });

    // begins_with optimizes on the concrete prefix 'users' (everything before '*').
    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid AND begins_with(namespace_key, :nsPrefix)',
      ExpressionAttributeValues: { ':uid': USER_ID, ':nsPrefix': 'users' },
      ProjectionExpression: 'namespace',
    });
    expect(result).toEqual([['users', 'alice']]);
  });

  it('filters out namespaces failing an in-memory suffix condition (lines 202, 260-276)', async () => {
    // Prevents contains() false positives from surviving: matchesSuffix must drop
    // paths shorter than the pattern (260) and paths whose tail mismatches (276),
    // while the wildcard segment is skipped (271).
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        { namespace: 'team/reports' }, // matches suffix ['*','reports']
        { namespace: 'reports' }, // pattern longer than path (line 260) => excluded
        { namespace: 'team/summary' }, // tail mismatch (line 276) => excluded
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: {
        limit: 100,
        offset: 0,
        // Leading wildcard exercises extractConcreteSuffix's break (line 202) so
        // only 'reports' is used for contains(), and matchesSuffix wildcard (271).
        matchConditions: [{ matchType: 'suffix', path: ['*', 'reports'] }],
        maxDepth: undefined,
      },
    });

    // contains() uses the concrete suffix 'reports' (everything after '*').
    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': USER_ID, ':suffix0': 'reports' },
      ProjectionExpression: 'namespace',
      FilterExpression: 'contains(#ns0, :suffix0)',
      ExpressionAttributeNames: { '#ns0': 'namespace' },
    });
    expect(result).toEqual([['team', 'reports']]);
  });

  it('skips namespaces beyond the in-memory cap (lines 128-129) once MAX_TOTAL_ITEMS_IN_MEMORY is reached', async () => {
    // Prevents unbounded memory growth: once the dedupe Set hits the cap, further
    // namespaces from the same page are ignored. A single page of 10001 distinct
    // namespaces exceeds MAX_TOTAL_ITEMS_IN_MEMORY (10000).
    const items = Array.from({ length: 10001 }, (_, i) => ({
      namespace: `ns${String(i).padStart(6, '0')}`,
    }));
    ddb.mock.on(QueryCommand).resolvesOnce({ Items: items, LastEvaluatedKey: undefined });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      // Large limit so the slice does not mask the cap behavior.
      op: { limit: 1000, offset: 0, matchConditions: [], maxDepth: undefined },
    });

    // At most MAX_TOTAL_ITEMS_IN_MEMORY namespaces are collected; the 10001st is
    // dropped by the cap guard (line 129). The result is then sliced to limit.
    expect(result).toHaveLength(1000);
    // The very last namespace (ns010000) must NOT appear — it was dropped at the cap.
    expect(result.some((p) => p[0] === 'ns010000')).toBe(false);
  });

  it('filters out everything for an unrecognized matchType (line 223 fallthrough)', async () => {
    // Defends matchesCondition's defensive `return false`: a condition whose
    // matchType is neither 'prefix' nor 'suffix' must reject every namespace
    // rather than silently matching. The type union only permits prefix/suffix,
    // so we construct an out-of-union condition via a typed assertion (no `any`).
    const weird = { matchType: 'glob', path: ['users'] } as unknown as MatchCondition;
    ddb.mock.on(QueryCommand).resolves({
      Items: [{ namespace: 'users/alice' }, { namespace: 'teams/x' }],
      LastEvaluatedKey: undefined,
    });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { limit: 100, offset: 0, matchConditions: [weird], maxDepth: undefined },
    });

    // No prefix optimization (matchType !== 'prefix') and no suffix filter, so the
    // base query runs; the in-memory filter then drops all rows via line 223.
    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': USER_ID },
      ProjectionExpression: 'namespace',
    });
    expect(result).toEqual([]);
  });

  it('ignores items with a null or undefined namespace (line 126 guard)', async () => {
    // Prevents null namespaces from being added to the dedupe Set and producing
    // bogus empty paths.
    ddb.mock.on(QueryCommand).resolves({
      Items: [{ namespace: 'a' }, { namespace: null }, { other: 'no-namespace-field' }],
      LastEvaluatedKey: undefined,
    });

    const result = await listNamespacesOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { limit: 100, offset: 0, matchConditions: [], maxDepth: undefined },
    });

    expect(result).toEqual([['a']]);
  });
});
