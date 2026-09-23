/**
 * Hides the history's key layout and how a message becomes a row and back.
 *
 * A session is one partition: a SESSION row with a fixed sort key, and one
 * message row per message, sorted by its ULID so a range query reads a window
 * in order. How those keys are composed, how a session's rows are queried, and
 * which rows a read admits as this adapter's messages are decided here. What
 * the SESSION row carries is `session.ts`'s decision; where it lives is this
 * module's.
 */

import type { QueryCommandInput } from '@aws-sdk/lib-dynamodb';
import type { StoredMessage } from '@langchain/core/messages';

import { type CodecDeps, type PayloadDescriptor } from '../../shared/codec/codec';
import { encodePayload } from '../../shared/codec/encode';
import type { DocItem } from '../../shared/dynamodb/client';
import {
  ADAPTER_TAGS,
  KEY_SEPARATOR,
  PARTITION_KEY_ATTRIBUTE,
  ROW_FORMAT_VERSION,
  type RowKey,
  SORT_KEY_ATTRIBUTE,
} from '../../shared/dynamodb/table-schema';
import type { SessionId } from './parse';
import type { HistoryContext } from './setup';

/**
 * Item-kind tag distinguishing this adapter's sort keys from another
 * adapter's on a table shared via `DynamoDBFactory.createAll()` — matches the
 * pattern the checkpointer module already uses for its own META#/PAYLOAD#/
 * WRITE# keys. Without it, `SESSION_SORT_KEY` alone was a bare, common-word
 * literal a store caller could produce by accident (e.g.
 * `store.put([sessionId], 'SESSION', ...)`, since `sortKey` collapses a
 * single-element namespace down to just the key).
 */
const ADAPTER_PREFIX = `HISTORY${KEY_SEPARATOR}`;

/** Fixed sort key for the per-session metadata item. */
export const SESSION_SORT_KEY = `${ADAPTER_PREFIX}SESSION`;

const MESSAGE_PREFIX = `${ADAPTER_PREFIX}MSG#`;

/**
 * Adapter tag prefixed to every chat-history partition key — see the
 * equivalent in checkpointer/internal/rows.ts for why the three adapters'
 * partitions must not overlap on a shared table.
 */
const ADAPTER_PARTITION_PREFIX = `${ADAPTER_TAGS.history}${KEY_SEPARATOR}`;

/**
 * The tag every chat-history partition key starts with.
 *
 * Accepts: nothing — the tag is fixed, and the function exists so no caller
 * composes it by hand.
 *
 * Returns: the tag, for a table-wide `begins_with` over this adapter's rows.
 *
 * Throws: nothing.
 */
export function historyPartitionPrefix(): string {
  return ADAPTER_PARTITION_PREFIX;
}

/**
 * Partition key for a chat session: the adapter tag plus the session id.
 *
 * Accepts: `sessionId` — normally validated, so it cannot contain the
 * separator and the key is unambiguous.
 *
 * Returns: the partition key. A whole session lives in one partition, which is
 * what makes a session read one Query and a session delete one partition walk.
 *
 * Throws: nothing.
 */
export function sessionPartition(sessionId: string): string {
  return `${ADAPTER_PARTITION_PREFIX}${sessionId}`;
}

/**
 * The key of a session's SESSION row.
 *
 * Accepts: `sessionId` — the session's id, parsed, or read off the row.
 *
 * Returns: the row's partition and its fixed sort key.
 *
 * Throws: nothing.
 */
export function sessionRowKey(sessionId: string): RowKey {
  return { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY };
}

/**
 * Sort key for a single message item.
 *
 * Accepts: `ulid` — a monotonic ULID, or the time-prefix of one when the caller
 * is building a range bound rather than a key.
 *
 * Returns: the sort key. ULIDs sort lexicographically in time order, so the
 * sort key *is* the chronological order; nothing re-sorts messages on read.
 *
 * Throws: nothing.
 */
export function messageSortKey(ulid: string): string {
  return `${MESSAGE_PREFIX}${ulid}`;
}

/**
 * Whether `sortKey` is one this adapter writes.
 *
 * Accepts: any sort key read from the session's partition.
 *
 * Returns: whether this adapter owns the row. A partition query carries no
 * sort-key condition, so a partition-wide delete uses this to leave a row it
 * does not own in place rather than deleting the whole partition blindly.
 *
 * Throws: nothing.
 */
export function isHistorySortKey(sortKey: string): boolean {
  return sortKey.startsWith(ADAPTER_PREFIX);
}

/**
 * `begins_with` prefix selecting every message item in a session.
 *
 * Accepts: nothing — the prefix is the same for every session, because the
 * session is already the partition.
 *
 * Returns: the prefix, which excludes the SESSION metadata row: that row shares
 * the partition but is not a message.
 *
 * Throws: nothing.
 */
export function messageSortKeyPrefix(): string {
  return MESSAGE_PREFIX;
}

/** Options for {@link sessionItemsQuery}. */
export interface SessionItemsQueryOptions {
  consistent?: boolean;
}

/**
 * Query input selecting every item in a session's partition.
 *
 * Accepts: `options.consistent` — for a read whose answer a write depends on.
 *
 * Returns: the Query input, with no sort-key condition: it selects the
 * messages, the SESSION metadata row, and any row another adapter left in this
 * partition — which is why every caller filters with `isHistorySortKey`.
 *
 * Throws: nothing.
 */
export function sessionItemsQuery(
  tableName: string,
  sessionId: SessionId,
  options: SessionItemsQueryOptions = {},
): QueryCommandInput {
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk',
    ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE },
    ExpressionAttributeValues: { ':pk': sessionPartition(sessionId) },
  };
  if (options.consistent) params.ConsistentRead = true;
  return params;
}

/** Options for {@link messageQuery}. */
export interface MessageQueryOptions extends SessionItemsQueryOptions {
  /** Walk the messages newest-first; the caller restores chronological order. */
  descending?: boolean;
  /** Cap the rows DynamoDB evaluates per page. */
  limit?: number;
  /**
   * Exclusive upper sort-key bound. Expressed as `BETWEEN prefix AND bound`
   * because a key condition allows one sort-key operator: the bound is the
   * message prefix plus the ULID time characters of an instant, so every
   * real message key from that millisecond onwards sorts strictly after it.
   */
  beforeSortKey?: string;
}

/**
 * Query input selecting a session's message items.
 *
 * Accepts: `options.descending` — newest-first, which is how a tail window is
 * read. `options.limit` — the rows DynamoDB evaluates per page, not a total.
 * `options.beforeSortKey` — an upper bound, expressed as `BETWEEN prefix AND
 * bound` because a key condition allows one sort-key operator.
 *
 * Returns: the Query input, selecting messages only — the SESSION row does not
 * carry the message prefix.
 *
 * Throws: nothing.
 */
export function messageQuery(
  tableName: string,
  sessionId: SessionId,
  options: MessageQueryOptions = {},
): QueryCommandInput {
  const params: QueryCommandInput = {
    TableName: tableName,
    KeyConditionExpression: '#pk = :pk AND begins_with(#sk, :skp)',
    ExpressionAttributeNames: { '#pk': PARTITION_KEY_ATTRIBUTE, '#sk': SORT_KEY_ATTRIBUTE },
    ExpressionAttributeValues: {
      ':pk': sessionPartition(sessionId),
      ':skp': messageSortKeyPrefix(),
    },
    ScanIndexForward: !options.descending,
  };
  if (options.beforeSortKey !== undefined) {
    params.KeyConditionExpression = '#pk = :pk AND #sk BETWEEN :skp AND :before';
    params.ExpressionAttributeValues![':before'] = options.beforeSortKey;
  }
  if (options.limit !== undefined) params.Limit = options.limit;
  if (options.consistent) params.ConsistentRead = true;
  return params;
}

/** A single stored chat message item (one per message, ordered by its ULID). */
export interface ChatMessageItem {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `table-schema.ts`). */
  v?: number;
  sessionId: string;
  message: PayloadDescriptor;
  ttl?: number;
}

function codecDeps(context: HistoryContext, signal?: AbortSignal): CodecDeps {
  return {
    serde: context.serde,
    compression: context.compression,
    offloader: context.offloader,
    signal,
  };
}

/** One message as the row it becomes. */
export interface MessageRowSource {
  readonly sessionId: SessionId;
  /** The message's own ULID: its sort key and the id its offloaded object is written under. */
  readonly messageId: string;
  readonly message: StoredMessage;
  /** When the row expires; absent when the adapter has no ttl. */
  readonly ttlTimestamp?: number;
}

/**
 * Encode a single stored message into its DynamoDB item.
 *
 * Accepts: `source.sessionId` — the session the message belongs to.
 * `source.messageId` — the message's own id, which orders it and names its
 * offloaded object; the caller allocates one per message from a monotonic
 * factory. `source.message` — the message in its stored form.
 * `source.ttlTimestamp` — the uniform whole-conversation expiry every
 * message in the session shares, so a conversation expires as one thing rather
 * than losing its oldest turns first. `signal` — cancels the upload an
 * offloaded message costs.
 *
 * Returns: the row, keyed by the session partition and a `MSG#<messageId>` sort
 * key, its payload inline or offloaded to
 * `<keyPrefix><sessionId, base64url>/<messageId>.bin`.
 *
 * Throws: `VALIDATION` naming `value` for a message the serializer cannot
 * represent; `S3_OFFLOAD_FAILED` when an offloaded payload cannot be uploaded.
 * Encoding precedes the transaction, so a message that cannot be stored never
 * half-writes a turn.
 */
export async function buildMessageItem(
  context: HistoryContext,
  source: MessageRowSource,
  signal?: AbortSignal,
): Promise<ChatMessageItem> {
  const { sessionId, messageId, message, ttlTimestamp } = source;
  const pk = sessionPartition(sessionId);
  const sk = messageSortKey(messageId);
  const descriptor = await encodePayload(message, codecDeps(context, signal), {
    keyParts: [sessionId],
    objectId: messageId,
    row: { pk, sk },
  });
  const item: ChatMessageItem = {
    PK: pk,
    SK: sk,
    v: ROW_FORMAT_VERSION,
    sessionId,
    message: descriptor,
  };
  if (ttlTimestamp !== undefined) item.ttl = ttlTimestamp;
  return item;
}

/**
 * Narrow a raw row to a {@link ChatMessageItem}.
 *
 * Accepts: `raw` — any row read from a session's partition under the message
 * sort-key prefix, which on a shared table another writer can produce too.
 *
 * Returns: the item, or undefined for a row that merely shares the prefix —
 * one carrying no `sessionId`, no `message` descriptor, or a `sessionId` that
 * disagrees with the partition it was found in. The test is on the attributes
 * a message must have, not on a cast: this is the one boundary where a row may
 * not have been written by this adapter, and the read used to trust the key it
 * was found at. A `message` of `null` is refused here, as
 * `narrowMetaItem` refuses a `metadata` of `null`.
 *
 * Throws: nothing; a row a newer release wrote is the caller's to refuse,
 * before the shape is judged against attribute types that release may no
 * longer use.
 *
 * Guarantees: a row's attributes are bound to the partition it lives in, so a
 * row planted under one session cannot claim to belong to another.
 */
export function narrowMessageItem(raw: DocItem): ChatMessageItem | undefined {
  const shaped =
    typeof raw.sessionId === 'string' && typeof raw.message === 'object' && raw.message !== null;
  if (!shaped) return undefined;
  const item = raw as ChatMessageItem;
  return item.PK === sessionPartition(item.sessionId) ? item : undefined;
}
