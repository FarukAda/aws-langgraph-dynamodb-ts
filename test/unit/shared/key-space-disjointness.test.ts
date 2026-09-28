import { ScanCommand } from '@aws-sdk/lib-dynamodb';

import { partitionKey as checkpointerPartition } from '../../../src/checkpointer/internal/rows';
import { listSessions } from '../../../src/history/actions/list-sessions';
import {
  SESSION_SORT_KEY,
  historyPartitionPrefix,
  sessionPartition,
} from '../../../src/history/internal/rows';
import type { HistoryContext } from '../../../src/history/internal/setup';
import { JSON_SERDE } from '../../../src/shared/codec/json-serde';
import { ADAPTER_TAGS } from '../../../src/shared/dynamodb/table-schema';
import { ErrorCode } from '../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../src/shared/logging/logger';
import { searchItems } from '../../../src/store/actions/search';
import {
  buildStoreRow,
  partitionKey as storePartition,
  sortKey,
  storePartitionPrefix,
} from '../../../src/store/internal/rows';
import type { StoreContext } from '../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../shared/helpers/ddb-mock';
import { parsedSearch } from '../../shared/helpers/parsed-inputs';
import { simulatedScan } from '../../shared/helpers/simulated-scan';

/**
 * C1/C2: every adapter used to write a bare, untagged caller-supplied string
 * as its partition key, so one identifier reused across adapters on a table
 * shared via `DynamoDBFactory.createAll()` put unrelated rows in one
 * partition. `deleteThread`/`history.clear` then deleted the whole partition,
 * and composed sort keys could collide byte-for-byte. Adapter tags make the
 * three key spaces disjoint by construction.
 */
describe('cross-adapter partition-key disjointness', () => {
  const shared = 'conv-1';

  it('gives one identifier three distinct partitions, one per adapter', () => {
    const keys = [
      checkpointerPartition(shared),
      sessionPartition(shared),
      storePartition([shared]),
    ];
    expect(new Set(keys).size).toBe(3);
    expect(new Set(Object.values(ADAPTER_TAGS).map((tag) => tag[0])).size).toBe(3);
  });

  it('tags each partition with its own adapter', () => {
    expect(checkpointerPartition(shared)).toBe('CHKPT#conv-1');
    expect(sessionPartition(shared)).toBe('HIST#conv-1');
    expect(storePartition([shared, 'docs'])).toBe('STORE#conv-1');
  });

  it('cannot be made to collide by embedding another adapter tag in the identifier', () => {
    // The tags differ in their first character, so no suffix can bridge them —
    // and `#` is rejected inside every identifier anyway (see parseIdentifier).
    expect(checkpointerPartition('HIST#x')).not.toBe(sessionPartition('x'));
    expect(storePartition(['CHKPT#x'])).not.toBe(checkpointerPartition('x'));
    expect(sessionPartition('STORE#x')).not.toBe(storePartition(['x']));
  });

  /**
   * The partitions are disjoint; the *sort* keys are not. A store namespace
   * element may not contain the separator, but the join inserts one, so the
   * legal namespace `['t', 'HISTORY']` with the key `'SESSION'` composes the
   * chat-history adapter's own session sort key byte for byte. Nothing is
   * mis-keyed by it — the two rows sit in different partitions — but a read
   * that selects on the sort key alone meets both.
   */
  it('lets a legal store key compose the chat-history session sort key exactly', () => {
    expect(sortKey(['t', 'HISTORY'], 'SESSION')).toBe(SESSION_SORT_KEY);
    expect(storePartition(['t', 'HISTORY'])).not.toBe(sessionPartition('t'));
  });
});

function storeContext(client: StoreContext['client']): StoreContext {
  return {
    client,
    tableName: 'shared',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    maxIterations: 1000,
    vectorScoreDirection: 'relevance',
  };
}

function historyContext(client: HistoryContext['client']): HistoryContext {
  return {
    client,
    tableName: 'shared',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    onCorruptMessage: 'skip',
  };
}

/** A SESSION row as this package writes it. */
const sessionRow = (id: string, at: string) => ({
  PK: sessionPartition(id),
  SK: SESSION_SORT_KEY,
  sessionId: id,
  messageCount: 1,
  createdAt: at,
  updatedAt: at,
});

/**
 * The two reads that cross partitions by construction are the two that used to
 * select on something other than the key: the store's rootless scan tested for
 * a `namespace` attribute, and the session scan for a sort key both adapters
 * can compose. Either one therefore met rows outside its own key space, and
 * since a row carrying a format version above this release is *reported* rather
 * than skipped, one such row anywhere on a shared table failed a read that had
 * no business seeing it.
 *
 * These drive the reads through a scan that evaluates the filter the code
 * actually emitted, so what is asserted is which rows reach the narrow — not
 * the text of an expression.
 */
describe('a cross-partition scan reads only its own adapter key space', () => {
  it('keeps store.search([]) away from a foreign row a newer release wrote', async () => {
    const { client, mock } = createStrictDocumentMock();
    const context = storeContext(client);
    const mine = await buildStoreRow(
      context,
      { namespace: ['users', 'u1'], key: 'k0' },
      { kind: 'note' },
      { createdAt: 'c', updatedAt: 'u' },
    );
    const foreign = {
      PK: 'APP#tenant',
      SK: 'DOC#1',
      namespace: ['users', 'u1'],
      key: 'k0',
      v: 2,
    };
    mock.on(ScanCommand).callsFake(simulatedScan([mine, foreign]));

    const items = await searchItems(context, parsedSearch({ namespacePrefix: [], limit: 10 }));

    expect(items.map((item) => item.key)).toEqual(['k0']);
  });

  it('keeps listSessions away from a store row a newer release wrote', async () => {
    const { client, mock } = createStrictDocumentMock();
    const planted = {
      PK: storePartition(['t', 'HISTORY']),
      SK: sortKey(['t', 'HISTORY'], 'SESSION'),
      namespace: ['t', 'HISTORY'],
      key: 'SESSION',
      v: 2,
    };
    mock
      .on(ScanCommand)
      .callsFake(simulatedScan([planted, sessionRow('s1', '2026-01-01T00:00:00Z')]));

    const page = await listSessions(historyContext(client), { limit: 10 });

    expect(page.sessions.map((session) => session.sessionId)).toEqual(['s1']);
  });

  /**
   * The other half of the same change: a filter tightened one character too far
   * silently empties a listing. Two partition roots that share no prefix beyond
   * the adapter tag must both survive it.
   */
  it('still returns every one of its own rows', async () => {
    const { client, mock } = createStrictDocumentMock();
    const context = storeContext(client);
    const rows = await Promise.all([
      buildStoreRow(
        context,
        { namespace: ['users', 'u1'], key: 'k0' },
        { n: 1 },
        { createdAt: 'c', updatedAt: 'u' },
      ),
      buildStoreRow(
        context,
        { namespace: ['agents'], key: 'k1' },
        { n: 2 },
        { createdAt: 'c', updatedAt: 'u' },
      ),
    ]);
    mock.on(ScanCommand).callsFake(simulatedScan(rows));

    const items = await searchItems(context, parsedSearch({ namespacePrefix: [], limit: 10 }));

    expect(items.map((item) => item.key).sort()).toEqual(['k0', 'k1']);
  });

  it('still lists every session row of its own', async () => {
    const { client, mock } = createStrictDocumentMock();
    const rows = [
      sessionRow('s1', '2026-01-01T00:00:00Z'),
      sessionRow('s2', '2026-01-02T00:00:00Z'),
    ];
    mock.on(ScanCommand).callsFake(simulatedScan(rows));

    const page = await listSessions(historyContext(client), { limit: 10 });

    expect(page.sessions.map((session) => session.sessionId)).toEqual(['s2', 's1']);
  });

  /** The filters name the tags the key builders use, so the two cannot drift apart. */
  it('filters on the tag its own partition keys carry', () => {
    expect(storePartition(['users'])).toContain(storePartitionPrefix());
    expect(sessionPartition('s1')).toContain(historyPartitionPrefix());
    expect(storePartition(['users']).startsWith(historyPartitionPrefix())).toBe(false);
  });
});

/**
 * A row this release wrote reaches the reads that look for it, so the filter
 * cannot be shown safe only by what it excludes.
 */
describe('the forward-version refusal still fires inside the key space', () => {
  it('reports a store row a newer release wrote in the store key space', async () => {
    const { client, mock } = createStrictDocumentMock();
    const context = storeContext(client);
    const mine = await buildStoreRow(
      context,
      { namespace: ['users', 'u1'], key: 'k0' },
      { kind: 'note' },
      { createdAt: 'c', updatedAt: 'u' },
    );
    mock.on(ScanCommand).callsFake(simulatedScan([{ ...mine, v: 2 }]));

    await expect(
      searchItems(context, parsedSearch({ namespacePrefix: [], limit: 10 })),
    ).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });

  it('reports a session row a newer release wrote in the chat-history key space', async () => {
    const { client, mock } = createStrictDocumentMock();
    const row = { ...sessionRow('s1', '2026-01-01T00:00:00Z'), v: 2 };
    mock.on(ScanCommand).callsFake(simulatedScan([row]));

    await expect(listSessions(historyContext(client), { limit: 10 })).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'v' },
    });
  });
});
