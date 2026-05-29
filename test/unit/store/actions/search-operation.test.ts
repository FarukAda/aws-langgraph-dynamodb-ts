/**
 * Unit tests for src/store/actions/search-operation.ts.
 *
 * Characterizes the EXISTING searchOperationAction. Locks:
 *  - the QueryCommand shape: KeyConditionExpression (with/without begins_with),
 *    ExpressionAttributeValues, Limit sizing for non-semantic search
 *  - the FilterExpression + EAN/EAV ordering produced by buildFilterExpression
 *    (the #value alias is injected, fields become #attr0/:valN, ...)
 *  - the embedding-backed (semantic) query: Limit is undefined (fetch ALL),
 *    ranking returns the matching SearchItem shape
 *  - validation negatives and AbortSignal behavior
 *
 * Strict DDB mock, frozen time, pinned constants. The single mutable queryParams
 * object inside the action is cloned by aws-sdk-client-mock at command-call time,
 * so per-call inputs are asserted independently.
 */
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import { searchOperationAction } from '../../../../src/store/actions';
import { USER_ID } from '../../../shared/fixtures/test-data';
import { preAbortedSignal } from '../../../shared/helpers/abort';
import { captureLogger, type LoggerCapture } from '../../../shared/helpers/logger-capture';
import {
  expectExactQueryCommand,
  expectNoUnexpectedCommands,
} from '../../../shared/helpers/strict-ddb-assertions';
import { createStrictDdbMock, type StrictDdbMock } from '../../../shared/mocks/dynamodb';
import { makeEmbeddingMock, embeddingThrows } from '../../../shared/mocks/embedding';

const MEMORY_TABLE = 'memory-table';

function rowFor(key: string, value: Record<string, unknown>, namespace = 'ns') {
  return {
    namespace,
    key,
    value,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_500_000,
  };
}

describe('searchOperationAction', () => {
  let ddb: StrictDdbMock;

  beforeEach(() => {
    ddb = createStrictDdbMock();
  });

  afterEach(() => {
    ddb.mock.restore();
  });

  const client = (): DynamoDBDocument => ddb.mock as unknown as DynamoDBDocument;

  it('queries with user_id key condition only and default Limit (limit+offset) when no namespace prefix', async () => {
    ddb.mock.on(QueryCommand).resolves({
      Items: [rowFor('k1', { a: 1 })],
      LastEvaluatedKey: undefined,
    });

    const result = await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 5, offset: 0 },
    });

    // fetchTarget = limit + offset = 5; first iteration Limit = max(1, 5 - 0) = 5.
    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': USER_ID },
      Limit: 5,
    });
    expect(result).toEqual([
      {
        namespace: ['ns'],
        key: 'k1',
        value: { a: 1 },
        createdAt: new Date(1_700_000_000_000),
        updatedAt: new Date(1_700_000_500_000),
        score: undefined,
      },
    ]);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-7

  it('adds begins_with(namespace_key, :nsp) to the KeyConditionExpression when a namespace prefix is given', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: ['users', 'alice'], limit: 10, offset: 0 },
    });

    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid AND begins_with(namespace_key, :nsp)',
      ExpressionAttributeValues: { ':uid': USER_ID, ':nsp': 'users/alice' },
      Limit: 10,
    });
  }); // AC-7

  it('builds the FilterExpression with the injected #value alias and #attr0/:valN ordering', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 3, offset: 0, filter: { status: 'active' } },
    });

    // buildFilterExpression captures nameCounter=0 from the empty EAN before adding
    // #value, so the field `status` becomes #attr0. valueCounter starts at 1 (EAV
    // already holds :uid), so the value placeholder is :val1.
    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      FilterExpression: '#value.#attr0 = :val1',
      ExpressionAttributeNames: { '#value': 'value', '#attr0': 'status' },
      ExpressionAttributeValues: { ':uid': USER_ID, ':val1': 'active' },
      Limit: 3,
    });
  }); // AC-16

  it('performs a semantic query with Limit undefined (fetch ALL) and returns ranked SearchItems', async () => {
    const embedding = makeEmbeddingMock({ dimensions: 4 });
    // Row carries an embedding so it scores > 0 and survives the ranking filter.
    ddb.mock.on(QueryCommand).resolves({
      Items: [{ ...rowFor('k1', { text: 'match' }), embedding: [[0.1, 0.2, 0.3, 0.4]] }],
      LastEvaluatedKey: undefined,
    });

    const result = await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 10, offset: 0, query: 'match' },
      embedding,
    });

    // Semantic search sets fetchTarget = undefined => Limit is undefined.
    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': USER_ID },
      Limit: undefined,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ key: 'k1', namespace: ['ns'] });
    expect(typeof result[0].score).toBe('number');
  }); // AC-31

  it('returns [] without paginating further when the query yields no items', async () => {
    ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: undefined });

    const result = await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 5, offset: 0 },
    });

    expect(result).toEqual([]);
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-7

  it('rejects with the pagination ValidationError and issues no QueryCommand for a negative offset', async () => {
    await expect(
      searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 5, offset: -1 },
      }),
    ).rejects.toThrow('Offset cannot be negative');
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-17

  it('propagates a non-retryable ResourceNotFoundException from the QueryCommand', async () => {
    const err = Object.assign(new Error('no such table'), {
      name: 'ResourceNotFoundException',
    });
    ddb.mock.on(QueryCommand).rejects(err);

    await expect(
      searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 5, offset: 0 },
      }),
    ).rejects.toThrow('no such table');
    expectNoUnexpectedCommands(ddb.mock, [QueryCommand]);
  }); // AC-8

  it('short-circuits with zero DDB calls when the signal is already aborted', async () => {
    const reason = new Error('already-aborted');
    const signal = preAbortedSignal(reason);

    await expect(
      searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 5, offset: 0 },
        signal,
      }),
    ).rejects.toBe(reason);
    expectNoUnexpectedCommands(ddb.mock, []);
  }); // AC-18

  // ---- Extended coverage: branch/line gaps in search-operation.ts ----

  describe('with a captured logger', () => {
    let log: LoggerCapture;

    beforeEach(() => {
      log = captureLogger();
    });

    afterEach(() => {
      log.restore();
    });

    it('warns and skips text search (line 106) when `query` is given but no embedding is configured', async () => {
      // Prevents regressions where a query silently produces unfiltered results
      // without telling the caller that text search was dropped.
      ddb.mock.on(QueryCommand).resolves({
        Items: [rowFor('k1', { a: 1 })],
        LastEvaluatedKey: undefined,
      });

      const result = await searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 5, offset: 0, query: 'hello' },
        // no embedding => isSemanticSearch === false, fetchTarget = limit + offset
      });

      // Non-semantic: Limit is still the capped limit+offset.
      expectExactQueryCommand(ddb.mock, {
        TableName: MEMORY_TABLE,
        KeyConditionExpression: 'user_id = :uid',
        ExpressionAttributeValues: { ':uid': USER_ID },
        Limit: 5,
      });
      const warned = log.entries.filter((e) => e.level === 'warn');
      expect(warned).toHaveLength(1);
      expect(warned[0].message).toContain('text search is skipped');
      // Result still returned (filter/namespace matches only).
      expect(result).toEqual([
        {
          namespace: ['ns'],
          key: 'k1',
          value: { a: 1 },
          createdAt: new Date(1_700_000_000_000),
          updatedAt: new Date(1_700_000_500_000),
          score: undefined,
        },
      ]);
    });

    it('warns and truncates the corpus (lines 145-152) when a semantic page overflows the in-memory cap', async () => {
      // Prevents OOM regressions: semantic search must degrade to a partial ranked
      // corpus rather than throwing or loading unbounded items.
      const embedding = makeEmbeddingMock({ dimensions: 4 });
      // One page of 10001 rows (> MAX_TOTAL_ITEMS_IN_MEMORY = 10000), all with an
      // embedding so they survive ranking. LastEvaluatedKey present is irrelevant —
      // the overflow break fires first.
      const items = Array.from({ length: 10001 }, (_, i) => ({
        ...rowFor(`k${i}`, { i }),
        embedding: [[0.1, 0.2, 0.3, 0.4]],
      }));
      ddb.mock.on(QueryCommand).resolves({ Items: items, LastEvaluatedKey: { pk: 'next' } });

      const result = await searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 3, offset: 0, query: 'q' },
        embedding,
      });

      const warned = log.entries.filter((e) => e.level === 'warn');
      expect(warned.some((e) => e.message.includes('corpus truncated at 10000 items'))).toBe(true);
      // Only `limit` items are returned after ranking+pagination.
      expect(result).toHaveLength(3);
    });

    it('returns unranked items (lines 216-220) when embedQuery fails and fallbackToLexicalOnEmbeddingFailure is true', async () => {
      // Prevents the fail-open opt-in from being broken into a hard failure.
      ddb.mock.on(QueryCommand).resolves({
        Items: [{ ...rowFor('k1', { a: 1 }), embedding: [[0.1, 0.2, 0.3, 0.4]] }],
        LastEvaluatedKey: undefined,
      });

      const result = await searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 5, offset: 0, query: 'q' },
        embedding: embeddingThrows(new Error('embed boom')),
        fallbackToLexicalOnEmbeddingFailure: true,
      });

      const warned = log.entries.filter((e) => e.level === 'warn');
      expect(warned.some((e) => e.message.includes('embedding failed'))).toBe(true);
      // Items returned unranked (score is the row's own value: undefined here).
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('k1');
    });
  });

  it('throws (line 154) for a non-semantic search when one page overflows the in-memory cap', async () => {
    // Prevents silent truncation of non-semantic searches — a hard fail must
    // surface to the caller instead of returning a partial result set.
    const items = Array.from({ length: 10001 }, (_, i) => rowFor(`k${i}`, { i }));
    // limit+offset = 11000 so fetchTarget does not break before the overflow check.
    ddb.mock.on(QueryCommand).resolves({ Items: items, LastEvaluatedKey: { pk: 'next' } });

    await expect(
      searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 1000, offset: 10000 },
      }),
    ).rejects.toThrow('Search operation exceeded maximum items in memory limit');
  });

  it('throws (line 121) the iteration-limit error when paging never terminates', async () => {
    // Prevents an infinite pagination loop: the action must bail after
    // MAX_LOOP_ITERATIONS (1000) when DDB keeps returning a LastEvaluatedKey.
    // Empty pages keep items.length at 0 so the fetchTarget break never fires.
    ddb.mock.on(QueryCommand).resolves({ Items: [], LastEvaluatedKey: { pk: 'never-ends' } });

    await expect(
      searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 5, offset: 0 },
      }),
    ).rejects.toThrow('Search operation exceeded maximum iteration limit');
  });

  it('paginates across pages (lines 129-130) setting ExclusiveStartKey from the prior LastEvaluatedKey', async () => {
    // Prevents a regression where the second page request drops ExclusiveStartKey
    // and re-reads the first page. Two pages of 3 each, fetchTarget = 6.
    ddb.mock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [rowFor('k0', { i: 0 }), rowFor('k1', { i: 1 }), rowFor('k2', { i: 2 })],
        LastEvaluatedKey: { pk: 'page1' },
      })
      .resolvesOnce({
        Items: [rowFor('k3', { i: 3 }), rowFor('k4', { i: 4 }), rowFor('k5', { i: 5 })],
        LastEvaluatedKey: undefined,
      });

    const result = await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 6, offset: 0 },
    });

    // Two pages fetched. NOTE: the action mutates a single queryParams object and
    // passes it by reference to each QueryCommand, so the recorded inputs all
    // reflect the FINAL mutation — per-call Limit/ExclusiveStartKey cannot be
    // asserted independently here. We assert the call COUNT (the pagination
    // happened) and that the final recorded input carries the ExclusiveStartKey
    // set from the prior page's LastEvaluatedKey (lines 129-130).
    const calls = ddb.mock.commandCalls(QueryCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1].args[0].input).toEqual({
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': USER_ID },
      Limit: 3,
      ExclusiveStartKey: { pk: 'page1' },
    });
    expect(result).toHaveLength(6);
  });

  it('stops at the fetchTarget break (line 162) when a page still has a LastEvaluatedKey but enough items are collected', async () => {
    // Prevents over-fetching: once limit+offset items are in memory the loop must
    // break even though DDB advertises more pages.
    ddb.mock.on(QueryCommand).resolvesOnce({
      Items: [rowFor('k0', { i: 0 }), rowFor('k1', { i: 1 }), rowFor('k2', { i: 2 })],
      LastEvaluatedKey: { pk: 'more-pages-available' },
    });

    const result = await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 3, offset: 0 },
    });

    // Exactly one query — the break at line 162 prevents a second page fetch.
    expectExactQueryCommand(ddb.mock, {
      TableName: MEMORY_TABLE,
      KeyConditionExpression: 'user_id = :uid',
      ExpressionAttributeValues: { ':uid': USER_ID },
      Limit: 3,
    });
    expect(result).toHaveLength(3);
  });

  it('propagates the embedQuery error (lines 212-214) when fallbackToLexicalOnEmbeddingFailure is false', async () => {
    // Prevents the fail-closed default from silently degrading: an embed failure
    // must reach the caller so they can retry or degrade explicitly.
    ddb.mock.on(QueryCommand).resolves({
      Items: [{ ...rowFor('k1', { a: 1 }), embedding: [[0.1, 0.2, 0.3, 0.4]] }],
      LastEvaluatedKey: undefined,
    });

    await expect(
      searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 5, offset: 0, query: 'q' },
        embedding: embeddingThrows(new Error('embed boom')),
        // fallbackToLexicalOnEmbeddingFailure defaults to false
      }),
    ).rejects.toThrow('embed boom');
  });

  it('assigns score 0 and filters out items without embeddings (line 228) during ranking', async () => {
    // Prevents items lacking an embedding from leaking into semantic results: they
    // must be scored 0 and dropped by the >0 filter.
    const embedding = makeEmbeddingMock({ dimensions: 4 });
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        // No embedding field => score 0 => filtered out.
        rowFor('no-emb', { a: 1 }),
        // Has an embedding => survives ranking.
        { ...rowFor('with-emb', { a: 2 }), embedding: [[0.5, 0.5, 0.5, 0.5]] },
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 10, offset: 0, query: 'q' },
      embedding,
    });

    expect(result).toHaveLength(1);
    expect(result[0].key).toBe('with-emb');
    expect(typeof result[0].score).toBe('number');
  });

  it('scores 0 via cosineSimilarity (lines 264-265) when an item embedding has a mismatched dimension', async () => {
    // Prevents a crash / NaN score when a stored embedding length differs from the
    // query embedding: cosineSimilarity returns 0 and the item is filtered out.
    const embedding = makeEmbeddingMock({ dimensions: 4 }); // query vec length 4
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        // Length-3 embedding mismatches the length-4 query => similarity 0 => filtered.
        { ...rowFor('mismatch', { a: 1 }), embedding: [[0.1, 0.2, 0.3]] },
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 10, offset: 0, query: 'q' },
      embedding,
    });

    // Score 0 => excluded by the >0 ranking filter => empty result.
    expect(result).toEqual([]);
  });

  it('scores 0 via cosineSimilarity (lines 272-273) when an item embedding is an all-zero vector', async () => {
    // Prevents a divide-by-zero NaN: a zero-magnitude vector yields similarity 0.
    const embedding = makeEmbeddingMock({ dimensions: 4 });
    ddb.mock.on(QueryCommand).resolves({
      Items: [{ ...rowFor('zero-vec', { a: 1 }), embedding: [[0, 0, 0, 0]] }],
      LastEvaluatedKey: undefined,
    });

    const result = await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 10, offset: 0, query: 'q' },
      embedding,
    });

    expect(result).toEqual([]);
  });

  it('propagates a ranking error (lines 249-250) when fallbackToLexicalOnEmbeddingFailure is false', async () => {
    // Prevents the ranking try/catch from swallowing a real failure under the
    // fail-closed default. A throwing `embedding` getter makes the .map callback
    // throw, which the outer ranking try/catch must re-raise.
    const embedding = makeEmbeddingMock({ dimensions: 4 });
    const row = rowFor('boom', { a: 1 });
    Object.defineProperty(row, 'embedding', {
      enumerable: true,
      get() {
        throw new Error('ranking boom');
      },
    });
    ddb.mock.on(QueryCommand).resolves({ Items: [row], LastEvaluatedKey: undefined });

    await expect(
      searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 5, offset: 0, query: 'q' },
        embedding,
      }),
    ).rejects.toThrow('ranking boom');
  });

  it('returns unranked items (lines 252-256) when ranking throws and fallbackToLexicalOnEmbeddingFailure is true', async () => {
    // Prevents the fail-open opt-in from being lost on the ranking path: a ranking
    // error must log a warning and return the raw items instead of throwing.
    const log = captureLogger();
    try {
      const embedding = makeEmbeddingMock({ dimensions: 4 });
      const row = rowFor('boom', { a: 1 });
      Object.defineProperty(row, 'embedding', {
        enumerable: true,
        get() {
          throw new Error('ranking boom');
        },
      });
      ddb.mock.on(QueryCommand).resolves({ Items: [row], LastEvaluatedKey: undefined });

      const result = await searchOperationAction({
        client: client(),
        memoryTableName: MEMORY_TABLE,
        userId: USER_ID,
        op: { namespacePrefix: [], limit: 5, offset: 0, query: 'q' },
        embedding,
        fallbackToLexicalOnEmbeddingFailure: true,
      });

      const warned = log.entries.filter((e) => e.level === 'warn');
      expect(warned.some((e) => e.message.includes('ranking failed'))).toBe(true);
      // Raw item returned unranked.
      expect(result).toHaveLength(1);
      expect(result[0].key).toBe('boom');
    } finally {
      log.restore();
    }
  });

  it('applies offset slicing to semantic results (line 175) ranking the full corpus before paginating', async () => {
    // Prevents offset being ignored on the semantic path: the highest-ranked item
    // must be dropped by offset=1.
    const embedding = makeEmbeddingMock({ dimensions: 4 });
    // Two items with different embeddings so they rank deterministically.
    ddb.mock.on(QueryCommand).resolves({
      Items: [
        { ...rowFor('a', { a: 1 }), embedding: [[0.9, 0.1, 0.1, 0.1]] },
        { ...rowFor('b', { a: 2 }), embedding: [[0.1, 0.9, 0.1, 0.1]] },
      ],
      LastEvaluatedKey: undefined,
    });

    const result = await searchOperationAction({
      client: client(),
      memoryTableName: MEMORY_TABLE,
      userId: USER_ID,
      op: { namespacePrefix: [], limit: 10, offset: 1, query: 'q' },
      embedding,
    });

    // Full corpus ranked, then sliced [1, 1+10] => exactly one item remains.
    expect(result).toHaveLength(1);
  });
});
