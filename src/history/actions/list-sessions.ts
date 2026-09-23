import { nowSeconds as currentSeconds } from '../../shared/clock';
import { DEFAULT_READ_CONCURRENCY } from '../../shared/constants';
import type { DocItem } from '../../shared/dynamodb/client';
import { DEFAULT_INDEX_SHARDS } from '../../shared/dynamodb/index-keys';
import { queryRecencyIndex } from '../../shared/dynamodb/index-query';
import { retryFor } from '../../shared/dynamodb/retry-policy';
import { paginateScan } from '../../shared/dynamodb/scan';
import {
  assertReadableRow,
  isExpiredRow,
  PARTITION_KEY_ATTRIBUTE,
  SORT_KEY_ATTRIBUTE,
} from '../../shared/dynamodb/table-schema';
import { type PageLimit, parseLimit } from '../../shared/validation/primitives';
import { type ListSessionsRequest, parseListSessionsRequest } from '../internal/parse';
import { SESSION_SORT_KEY, historyPartitionPrefix, sessionPartition } from '../internal/rows';
import type { HistoryContext } from '../internal/setup';
import type { ChatSessionItem, ListSessionsOptions, SessionMetadata, SessionPage } from '../types';

/** Rows per page when the caller names none. */
const DEFAULT_PAGE_SIZE: PageLimit = parseLimit(100, 0);

/**
 * Whether a row's `ttl` is an instant this listing can both judge and render.
 *
 * Neither of the two things done with it refuses a value it cannot use.
 * {@link isExpiredRow} compares it against the clock, and a non-number compares
 * `false` against every clock, so an unreadable ttl reads as *live* rather than
 * being filtered out. `expiresAt` then renders it, and `NaN`, `Infinity` and
 * anything past the ±8.64e12 seconds a `Date` spans are all numbers whose
 * `toISOString` throws `RangeError` — which failed the whole listing.
 */
function hasReadableTtl(ttl: DocItem[string]): boolean {
  if (ttl === undefined) return true;
  return typeof ttl === 'number' && Number.isFinite(new Date(ttl * 1000).getTime());
}

/**
 * Whether every attribute {@link summarise} hands back is the type this package
 * writes there.
 *
 * The identity test above proves a row is a session row; this proves its own
 * attributes are usable. They are returned under declared types, so a row that
 * disagrees answers the caller with a lie — `messageCount: 'many'` handed back
 * as a number — or, for the ttl, with a `RangeError`. A row this release cannot
 * speak for is dropped the way a foreign row is, never at the cost of the rest
 * of the page.
 */
function isSummarisable(raw: DocItem): boolean {
  return (
    typeof raw.messageCount === 'number' &&
    typeof raw.createdAt === 'string' &&
    typeof raw.updatedAt === 'string' &&
    (raw.title === undefined || typeof raw.title === 'string') &&
    hasReadableTtl(raw.ttl)
  );
}

/**
 * The session a row describes, or undefined for a foreign, malformed or expired
 * row.
 *
 * The `sessionId` is bound to the partition the row was found in, as
 * `narrowMetaItem`, `narrowStoreRecord` and `narrowMessageItem` bind theirs.
 * Both reads that reach here select rows by something other than the partition
 * — a table scan filtered on the sort key, and a recency-index query — so
 * without the binding a row planted anywhere in the table under this adapter's
 * SESSION sort key was summarised under whatever `sessionId` it claimed, and a
 * caller taking that id to `getMessages` read a partition the row never lived
 * in.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer release wrote. It is not a
 * foreign row to skip, and summarising it under this release's rules could
 * return its attributes with a meaning they no longer have. Checked before the
 * shape, the binding and the ttl — as every other read of this package's rows
 * checks it — so a newer row is refused rather than judged against attribute
 * names it may no longer use, and the answer does not depend on the reading
 * machine's clock.
 */
function summarise(raw: DocItem, nowSeconds: number): SessionMetadata | undefined {
  const item = raw as ChatSessionItem;
  assertReadableRow(item, 'session');
  if (item.SK !== SESSION_SORT_KEY || typeof item.sessionId !== 'string') return undefined;
  if (item.PK !== sessionPartition(item.sessionId)) return undefined;
  if (!isSummarisable(raw) || isExpiredRow(item, nowSeconds)) return undefined;
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
 * Expired, foreign and malformed rows are dropped after the read, so a page can
 * come back shorter than `limit` while more rows remain. The cursor still advances,
 * because it is the position in the index rather than a count of what survived
 * filtering.
 */
async function pageFromIndex(
  context: HistoryContext,
  indexName: string,
  request: ListSessionsRequest,
): Promise<SessionPage> {
  const nowSeconds = currentSeconds();
  const page = await queryRecencyIndex({
    client: context.client,
    tableName: context.tableName,
    indexName,
    tag: 'SESS',
    shards: context.indexShards ?? DEFAULT_INDEX_SHARDS,
    concurrency: context.readConcurrency ?? DEFAULT_READ_CONCURRENCY,
    limit: request.limit ?? DEFAULT_PAGE_SIZE,
    cursor: request.cursor,
    retry: retryFor(context, request.signal),
    signal: request.signal,
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
 *
 * The filter names the partition tag before the sort key. The sort key alone
 * does not identify this adapter: a store namespace element may not hold the
 * separator, but the join inserts one, so the legal store key
 * `sortKey(['t', 'HISTORY'], 'SESSION')` composes `SESSION_SORT_KEY` byte for
 * byte. Such a row sits in a `STORE#` partition, and since a row stamped with a
 * format version above this release is *reported* rather than skipped, one of
 * them was enough to fail this listing on a table the three adapters share.
 * `summarise` already requires `PK` to equal `sessionPartition(sessionId)`, so
 * the tag excludes only rows it was dropping after the read. Filtering costs no
 * read capacity either way: DynamoDB applies it once the scan has finished.
 */
async function allByScan(
  context: HistoryContext,
  request: ListSessionsRequest,
): Promise<SessionPage> {
  const sessions: SessionMetadata[] = [];
  const nowSeconds = currentSeconds();
  for await (const raw of paginateScan({
    retry: retryFor(context, request.signal),
    signal: request.signal,
    client: context.client,
    params: {
      TableName: context.tableName,
      FilterExpression: 'begins_with(#pk, :pkp) AND #sk = :session',
      ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE, '#sk': SORT_KEY_ATTRIBUTE },
      ExpressionAttributeValues: {
        ':pkp': historyPartitionPrefix(),
        ':session': SESSION_SORT_KEY,
      },
    },
    maxIterations: request.maxIterations,
    maxItems: request.maxItems,
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
  return { sessions: request.limit === undefined ? sessions : sessions.slice(0, request.limit) };
}

/**
 * List sessions as metadata summaries, most recently updated first.
 *
 * Accepts: `options.limit` — the package-wide page rule, an integer from 0 to
 * the page ceiling; absent means one index page (100) with the index, and
 * every session without it, since a scan has no cursor to fetch the rest with.
 * `0` returns an empty page on either path without reading the table, which
 * matters most on the scan path: a scan has to finish before the newest can be
 * known, so answering `limit: 0` by scanning and then slicing to nothing would
 * have paid for the whole table to return an empty page.
 * `options.cursor` — from a previous page, and
 * only with a configured `indexName`. `options.maxItems` and
 * `maxIterations` — caps on the scan path; with the index the page size is the
 * bound and they do nothing. Each must be a positive integer or `Infinity`
 * (the paginator's own way to ask for no cap); absent keeps its default.
 *
 * Returns: the page, newest-updated first, and a `nextCursor` while rows may
 * remain. A page can come back shorter than `limit` while more remain: expired
 * and foreign rows are dropped after the read, and so is a row of this
 * package's own whose `messageCount`, `createdAt`, `updatedAt`, `title` or
 * `ttl` is not the type written there — one unreadable `ttl` used to fail the
 * whole call, taking every healthy session with it. The cursor is a position in
 * the index rather than a count of what survived filtering. A cursor does not
 * promise more rows: the page after it can come back empty (see
 * `queryRecencyIndex`).
 *
 * Throws: `VALIDATION` naming `limit`, `cursor`, `maxItems`,
 * `maxIterations`, `signal`, or `options.<key>` for a key this package does
 * not read; `RESULT_TRUNCATED` past the scan path's caps, or for an
 * index shard whose pages do not end within `MAX_LOOP_ITERATIONS`;
 * `FORMAT_UNSUPPORTED` for a SESSION row a newer release wrote, on either
 * path; `ABORTED`.
 *
 * Guarantees: with a configured `indexName` each index shard is read
 * newest-first one DynamoDB page at a time, and its next page whenever it has
 * no row buffered and the page still needs one, which can cost a query per
 * shard per page whose rows the page never takes; at most `readConcurrency`
 * shards are queried at once. Memory is the page being built, up to `limit`
 * rows and so bounded by the page ceiling, plus at most one DynamoDB page per shard,
 * whatever the table holds. Without one it is a filtered table scan that holds
 * every session at once and returns no cursor, as earlier releases did.
 */
export async function listSessions(
  context: HistoryContext,
  options: ListSessionsOptions = {},
): Promise<SessionPage> {
  const request = parseListSessionsRequest(options, context.indexName);
  if (request.limit === 0) return { sessions: [] };
  return context.indexName === undefined
    ? allByScan(context, request)
    : pageFromIndex(context, context.indexName, request);
}
