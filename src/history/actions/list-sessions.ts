import { nowSeconds as currentSeconds } from '../../shared/clock';
import { isExpiredRow } from '../../shared/dynamodb/expiry';
import { DEFAULT_INDEX_SHARDS } from '../../shared/dynamodb/index-keys';
import { queryRecencyIndex } from '../../shared/dynamodb/index-query';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { paginateScan } from '../../shared/dynamodb/scan';
import type { DocItem } from '../../shared/dynamodb/types';
import { ValidationError } from '../../shared/errors/errors';
import { validateInteger } from '../../shared/validation/primitives';
import { SESSION_SORT_KEY } from '../internal/keys';
import type { HistoryContext } from '../internal/setup';
import type { ChatSessionItem, ListSessionsOptions, SessionMetadata, SessionPage } from '../types';

/** Rows per page when the caller names none. */
const DEFAULT_PAGE_SIZE = 100;

/** The session a row describes, or undefined for a foreign or expired row. */
function summarise(raw: DocItem, nowSeconds: number): SessionMetadata | undefined {
  const item = raw as ChatSessionItem;
  if (item.SK !== SESSION_SORT_KEY || typeof item.sessionId !== 'string') return undefined;
  if (isExpiredRow(item, nowSeconds)) return undefined;
  return {
    sessionId: item.sessionId,
    title: item.title,
    messageCount: item.messageCount,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    expiresAt: item.ttl === undefined ? undefined : new Date(item.ttl * 1000).toISOString(),
  };
}

/**
 * One page from the recency index, newest-updated first.
 *
 * Expired and foreign rows are dropped after the read, so a page can come back
 * shorter than `limit` while more rows remain. The cursor still advances,
 * because it is the position in the index rather than a count of what survived
 * filtering.
 */
async function pageFromIndex(
  context: HistoryContext,
  indexName: string,
  options: ListSessionsOptions,
): Promise<SessionPage> {
  const nowSeconds = currentSeconds();
  const page = await queryRecencyIndex({
    client: context.client,
    tableName: context.tableName,
    indexName,
    tag: 'SESS',
    shards: context.indexShards ?? DEFAULT_INDEX_SHARDS,
    limit: options.limit ?? DEFAULT_PAGE_SIZE,
    cursor: options.cursor,
    retry: retryFor(context, options.signal),
    signal: options.signal,
  });
  const sessions = page.items
    .map((raw) => summarise(raw, nowSeconds))
    .filter((session): session is SessionMetadata => session !== undefined);
  return { sessions, ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }) };
}

/**
 * Every session, read by scanning the table and sorted in memory.
 *
 * The fallback for a table without the recency index. It consumes read capacity
 * for every row the scan *evaluates*, not every row it returns, and it holds
 * every session at once — which is why the index exists and why this path
 * offers no cursor.
 *
 * An explicit `limit` is honoured here as the newest N, the same thing it means
 * on the index path. It cannot bound the read — a scan has to finish before the
 * newest can be known — but answering a caller who asked for ten with five
 * thousand sessions was a wrong answer, not a cheaper one.
 */
async function allByScan(
  context: HistoryContext,
  options: ListSessionsOptions,
): Promise<SessionPage> {
  const sessions: SessionMetadata[] = [];
  const nowSeconds = currentSeconds();
  for await (const raw of paginateScan({
    retry: retryFor(context, options.signal),
    signal: options.signal,
    client: context.client,
    params: {
      TableName: context.tableName,
      FilterExpression: '#sk = :session',
      ExpressionAttributeNames: { '#sk': 'SK' },
      ExpressionAttributeValues: { ':session': SESSION_SORT_KEY },
    },
    maxIterations: options.maxIterations,
    maxItems: options.maxItems,
  })) {
    const session = summarise(raw, nowSeconds);
    if (session) sessions.push(session);
  }
  /**
   * Ordinal, not `localeCompare`: these are ISO-8601 timestamps, whose byte
   * order already is their chronological order. Locale-aware collation applies
   * rules (case folding, punctuation weighting) that have no meaning here and
   * are not guaranteed to agree with it in every locale.
   */
  sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { sessions: options.limit === undefined ? sessions : sessions.slice(0, options.limit) };
}

/**
 * Reject a page request neither path could honour.
 *
 * `limit` is validated on both paths, not just the index one: the same call
 * must not be checked on one table and silently accepted on another. A `cursor`
 * without the index names a position in an index that is not there — answering
 * it with the first page would hand back page one while the caller waits for
 * page two.
 */
function assertPageOptions(context: HistoryContext, options: ListSessionsOptions): void {
  if (options.limit !== undefined) validateInteger(options.limit, 'limit', { min: 1 });
  if (options.cursor !== undefined && context.indexName === undefined) {
    throw new ValidationError(
      'paging by cursor needs a configured `indexName`: without the recency index a listing is ' +
        'one table scan, which has no position to resume from',
      'cursor',
    );
  }
}

/**
 * List sessions as metadata summaries, most recently updated first.
 *
 * Accepts: `options.limit` — a positive integer; absent means one index page
 * (100) with the index, and every session without it, since a scan has no
 * cursor to fetch the rest with. `options.cursor` — from a previous page, and
 * only with a configured `indexName`. `options.maxItems` and
 * `maxIterations` — caps on the scan path; with the index the page size is the
 * bound and they do nothing.
 *
 * Returns: the page, newest-updated first, and a `nextCursor` when more rows
 * remain. A page can come back shorter than `limit` while more remain: expired
 * and foreign rows are dropped after the read, and the cursor is a position in
 * the index rather than a count of what survived filtering.
 *
 * Throws: ValidationError naming `limit` or `cursor`; {@link ResultTruncatedError}
 * past the scan path's caps; `AbortError`.
 *
 * Guarantees: with a configured `indexName` the cost is one bounded query per
 * index shard, whatever the table holds. Without one it is a filtered table
 * scan that returns every session at once and no cursor — the behaviour of
 * earlier releases, kept so that upgrading changes nothing until the index
 * exists.
 */
export async function listSessions(
  context: HistoryContext,
  options: ListSessionsOptions = {},
): Promise<SessionPage> {
  assertPageOptions(context, options);
  return context.indexName === undefined
    ? allByScan(context, options)
    : pageFromIndex(context, context.indexName, options);
}
