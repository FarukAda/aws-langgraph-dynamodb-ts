/**
 * Hides the SESSION row: what it carries and how each field changes.
 *
 * A session's metadata — `messageCount`, `title`, `createdAt`, `updatedAt`,
 * `ttl`, the `writeId` of the last append, and the recency-index keys — lives
 * on one row, and `messageCount` is a copy of a fact the message rows hold.
 * Keeping the copy in step is this module's job and nobody else's: the append
 * adds to it in the same transaction that writes the messages, a rolled-back
 * append subtracts exactly what it added (and never from a later incarnation of
 * the session), a repair recomputes it under a compare-and-swap, and a listing
 * reads it back only from a row this release can summarise. The recency-index
 * keys are the one field this module does not write alone: `sessionIndexTarget`
 * below tells `src/backfill/backfill.ts` which row is a SESSION row, and
 * backfill writes the keys onto it directly, for a row that predates the index.
 */

import type { NativeAttributeValue } from '@aws-sdk/lib-dynamodb';
import type { StoredMessage } from '@langchain/core/messages';

import { nowSeconds } from '../../shared/clock';
import { conditionFailedAt } from '../../shared/dynamodb/cancellation';
import type { AttributeMap, TransactAction } from '../../shared/dynamodb/client';
import {
  OVERWRITE_CAS_MAX_ATTEMPTS,
  transactIdempotently,
} from '../../shared/dynamodb/idempotent-write';
import {
  backfilledAt,
  DEFAULT_INDEX_SHARDS,
  indexKeys,
  type IndexTarget,
} from '../../shared/dynamodb/recency-index';
import { withDynamoDBRetry, retryFor } from '../../shared/dynamodb/retry';
import {
  assertReadableRow,
  isExpiredRow,
  PARTITION_KEY_ATTRIBUTE,
  ROW_FORMAT_VERSION,
} from '../../shared/dynamodb/table-schema';
import { classifyAwsError } from '../../shared/errors/classify';
import { ErrorCode } from '../../shared/errors/error-code';
import { conflictError } from '../../shared/errors/errors';
import type { SessionMetadata } from '../types';
import { countLiveMessages } from './message-read';
import type { SessionId } from './parse';
import { historyPartitionPrefix, SESSION_SORT_KEY, sessionPartition, sessionRowKey } from './rows';
import type { HistoryContext } from './setup';

/**
 * True when the transaction's first item — the SESSION row update or delete,
 * since both callers below send a single-item transaction — failed its
 * ConditionExpression. Named distinctly from
 * shared/dynamodb/idempotent-write.ts's isConditionalCheckFailed, which
 * classifies a rejection (a PutItem exception or a cancelled transaction's
 * reasons alike) without asking which item caused it — sharing that name
 * would be a real trap for whoever read one assuming it was the other.
 */
function isCancelledByCondition(error: Error): boolean {
  return conditionFailedAt(error, 0);
}

/**
 * Subtract a count this append already added from the session, leaving it consistent.
 * Guarded so a concurrently-deleted SESSION row is never resurrected as a
 * permanent, ttl-less junk row: if the row is already gone there is nothing
 * to revert, so that specific condition failure is swallowed rather than
 * surfaced — this runs only from an already-in-progress rollback, where a
 * spurious error for a no-op would misrepresent what happened.
 *
 * The same condition also pins the *incarnation*: `createdAt <= createdBefore`
 * (this call's own append timestamp). A session `clear()`-ed and re-created by
 * another caller between this call's commit and its rollback carries a later
 * `createdAt`; decrementing it would corrupt the new incarnation's count, and
 * its rows were never this call's to revert. That rejection is swallowed too,
 * for the same reason as a vanished row.
 *
 * Deliberately does not revert a `forceTtlRefresh`-driven ttl SET from an
 * earlier committed chunk: the healed anchor is never shorter than what
 * was there before, so leaving it in place after a rollback only means the
 * session's metadata row outlives its content a bit longer than ideal —
 * self-healing (the next successful append, or DynamoDB's own TTL sweep,
 * resolves it), unlike reverting, which would need to re-check for a
 * concurrent legitimate extension to avoid regressing it. See README.md's
 * "TTL expiry" section.
 *
 * Accepts: `delta` — how many messages to subtract; `0` is a no-op and spends
 * no write. `createdBefore` — this call's own append timestamp, which pins the
 * incarnation.
 *
 * Returns: nothing, whether the decrement applied or the guard correctly
 * refused it.
 *
 * Throws: whatever the write throws other than its own condition failure. A
 * vanished row and a newer incarnation are both "nothing of mine to revert",
 * not errors — this runs from an in-progress rollback, where a spurious error
 * for a no-op would misrepresent what happened.
 *
 * Guarantees: the decrement is applied at most once, however often the request
 * is re-sent. `ADD #count :neg` is one of the two writes in this package that
 * are not naturally idempotent — the append's own `ADD #count :n` is the
 * other — and applied twice it subtracts twice, with nothing reading the row
 * back afterwards to notice, so a re-sent attempt must be answered from
 * DynamoDB's idempotency cache rather than re-evaluated. Two things hold
 * that together and only together: the `ClientRequestToken`, which makes a
 * re-send a no-op, and the deadline of `MAX_WRITE_LIFETIME_MS`, which
 * stops the retrying while that token is still honoured. Nothing in the token
 * enforces that window — the service honours it for its own ten minutes
 * whatever a caller's retry policy says — so without the deadline a long
 * policy could still be retrying after the window closed, and the re-send
 * would then land as a second subtraction, leaving `messageCount` quietly
 * wrong. `reconcileMessageCount` is the repair if that happens anyway: it
 * recounts the live messages and writes the true total back.
 *
 * The guard is no second line of defence for it. An attempt the condition
 * turns away commits nothing, so DynamoDB caches no result for that attempt's
 * token and a retry is a fresh evaluation rather than a deduplicated one — the
 * exactly-once promise holds for an attempt that **committed**, which is also
 * the only attempt whose re-send could subtract twice.
 */
export async function revertSessionCount(
  context: HistoryContext,
  sessionId: SessionId,
  delta: number,
  createdBefore: string,
): Promise<void> {
  if (delta === 0) return;
  const update = {
    TableName: context.tableName,
    Key: sessionRowKey(sessionId),
    UpdateExpression: 'ADD #count :neg',
    ConditionExpression: `attribute_exists(${PARTITION_KEY_ATTRIBUTE}) AND #c <= :now`,
    ExpressionAttributeNames: { '#count': 'messageCount', '#c': 'createdAt' },
    ExpressionAttributeValues: { ':neg': -delta, ':now': createdBefore },
  };
  try {
    await transactIdempotently(context, [{ Update: update }]);
  } catch (error) {
    if (isCancelledByCondition(error as Error)) return;
    throw error;
  }
}

/** What a rolled-back append had created on the SESSION row, which the revert undoes. */
export interface CreatedSession {
  /** Messages the append added to `messageCount`. */
  readonly total: number;
  /** The `createdAt` the append stamped, which pins the revert to that incarnation. */
  readonly createdAt: string;
  /** The title the append contributed, if it contributed one. */
  readonly title?: string;
}

/**
 * Undo a rolled-back append's effect on the session row.
 *
 * When this call is the one that created the row — `createdAt` still equals
 * this call's timestamp, and the only messages counted on it are the ones
 * being reverted — the whole row is deleted. Without that, a failed first
 * append left a "ghost session": `title`, `createdAt` and `sessionId` are all
 * written via `if_not_exists`, so they were never reverted and never set
 * again, leaving `listSessions()` reporting a session with `messageCount: 0`
 * whose title still held up to 80 characters of a message the caller was told
 * had not persisted, with no API to clear it.
 *
 * Both conditions are load-bearing. `createdAt = :now` establishes that this
 * call created the row; `messageCount = :total` establishes that nothing else
 * has added to it since. A concurrent append to the same brand-new session
 * fails the count check, because deleting the row would destroy that caller's
 * committed messages — so it falls through to the plain decrement, and then
 * strips just the title this call contributed, which is the only part of the
 * row still carrying rolled-back message content.
 *
 * Accepts: `created` — what this call contributed to the row. `created.total`
 * — every message this call counted onto the row; `0` is a no-op.
 * `created.createdAt` — this call's timestamp, which is what "I created this
 * row" means here. `created.title` — the title this call may have contributed.
 *
 * Returns: nothing. The row is deleted, or decremented and stripped of this
 * call's title; both are a complete undo of what this call contributed.
 *
 * Throws: whatever the writes throw other than their own condition failures.
 *
 * Guarantees: the delete is applied at most once, and inside the window its
 * token is honoured for, a re-send of an attempt that **committed** is
 * answered from DynamoDB's idempotency cache rather than re-evaluated. The
 * condition would already stop such a re-send from removing anything it should
 * not; what the token adds is that it comes back as the success it was.
 * Re-evaluated instead, it finds the row gone, fails both equalities, and the
 * cancellation is read below as "a concurrent append has added to this row" —
 * sending a rollback that already completed down the decrement-and-strip path
 * meant for the case where the row survived. Both writes on that path are
 * themselves guarded, and the decrement's incarnation pin refuses a session
 * re-created in the meantime, so the price is two spurious conditional writes
 * rather than a wrong count; the token is what keeps them from being spent.
 *
 * A rejection carries no idempotency forward — a cancelled attempt commits
 * nothing, so nothing is cached for its token — and here that is exactly the
 * wanted behaviour, since the fall-through below is a fresh decision about
 * what to do instead. The deadline drawn beside the token is what keeps the
 * retrying inside that window; the token enforces no window of its own.
 */
export async function revertSessionCreation(
  context: HistoryContext,
  sessionId: SessionId,
  created: CreatedSession,
): Promise<void> {
  if (created.total === 0) return;
  try {
    await transactIdempotently(context, [
      {
        Delete: {
          TableName: context.tableName,
          Key: sessionRowKey(sessionId),
          ConditionExpression: '#count = :total AND #c = :now',
          ExpressionAttributeNames: { '#count': 'messageCount', '#c': 'createdAt' },
          ExpressionAttributeValues: { ':total': created.total, ':now': created.createdAt },
        },
      },
    ]);
    return;
  } catch (error) {
    if (!isCancelledByCondition(error as Error)) throw error;
  }
  await revertSessionCount(context, sessionId, created.total, created.createdAt);
  if (created.title !== undefined) {
    await removeRolledBackTitle(context, sessionId, created.createdAt, created.title);
  }
}

/** Fields driving the per-session metadata update inside the append transaction. */
export interface SessionUpdateFields {
  sessionId: string;
  /** Index partitions, from the adapter's context; see `indexKeys`. */
  indexShards?: number;
  /**
   * The id of the append writing this update, drawn per chunk transaction by
   * {@link writeMessageChunk}. It travels in the fields rather than being
   * minted inside the builder, so an attempt rebuilt for a retry carries the
   * id of the write it retries rather than a new one.
   */
  writeId: string;
  count: number;
  now: string;
  title?: string;
  ttlTimestamp?: number;
  forceTtlRefresh?: boolean;
}

/**
 * Build the metadata `Update` transact-item: `ADD` the message count and `SET`
 * `updatedAt` and the appending write's id every time, while `createdAt`,
 * `sessionId`, `title`, and the `ttl` anchor are written once via
 * `if_not_exists`. Folding the `ttl` anchor in here means the first append
 * fixes one shared expiry atomically with the count, with no separate
 * pre-write that could orphan a metadata-only row. When
 * `forceTtlRefresh` is set (because {@link resolveTtlAnchor} found the persisted
 * anchor missing or already expired), the `ttl` clause instead does a plain
 * `SET`, so the SESSION row's own stale attribute actually heals instead of
 * being permanently blocked by `if_not_exists`. When forceTtlRefresh is set,
 * the SET is additionally guarded by a ConditionExpression so a concurrent
 * caller's already-healed anchor can never be regressed backward — see
 * append.ts for how a lost race is retried without forcing.
 *
 * Accepts: `count` — how many messages this append adds, which `ADD` applies to
 * whatever the row holds, so two concurrent appends both count. `title` —
 * written once and never overwritten, so a session keeps the title its first
 * turn produced. `writeId` — the appending write's own id, rewritten on every
 * append so the row always names the write that last added to it.
 * `ttlTimestamp` — absent leaves the row without an expiry. `forceTtlRefresh` —
 * see above.
 *
 * Returns: the `Update` transact-item. It creates the row when there is none:
 * every once-only field is an `if_not_exists`, so the first append and the
 * thousandth build the same item.
 *
 * Throws: nothing. The condition it carries is evaluated by DynamoDB, and a
 * failed condition surfaces from the transaction, not from here.
 */
export function buildSessionUpdate(tableName: string, fields: SessionUpdateFields): TransactAction {
  const index = indexKeys(
    'SESS',
    fields.sessionId,
    fields.now,
    fields.indexShards ?? DEFAULT_INDEX_SHARDS,
  );
  const names: Record<string, string> = {
    '#count': 'messageCount',
    '#u': 'updatedAt',
    '#c': 'createdAt',
    '#sid': 'sessionId',
    '#wid': 'writeId',
    '#v': 'v',
    '#gpk': 'gsi1pk',
    '#gsk': 'gsi1sk',
  };
  const values: Record<string, NativeAttributeValue> = {
    ':n': fields.count,
    ':u': fields.now,
    ':c': fields.now,
    ':sid': fields.sessionId,
    ':wid': fields.writeId,
    ':v': ROW_FORMAT_VERSION,
    ':gpk': index.gsi1pk,
    ':gsk': index.gsi1sk,
  };
  // The row's format version is rewritten on every update, not only on
  // creation: an append by this version leaves a row this version wrote, and a
  // reader must be told that rather than infer it from which attributes happen
  // to be present.
  const sets = [
    '#u = :u',
    '#c = if_not_exists(#c, :c)',
    '#sid = if_not_exists(#sid, :sid)',
    // An unconditional `SET`, deliberately unlike the three `if_not_exists`
    // clauses around it. This is not a once-only field: its whole content is
    // that it moves. Written in their style it would stamp the id when the
    // session was created and never again, and a delete pinning on the id it
    // observed would be present, well formed, and always pass — which is the
    // failure it exists to prevent.
    '#wid = :wid',
    '#v = :v',
    // The session row is listed by recency across partitions, so it carries the
    // index keys — rewritten on every append, which is what keeps "most
    // recently updated first" true without an in-memory sort.
    '#gpk = :gpk',
    '#gsk = :gsk',
  ];
  if (fields.title !== undefined) {
    names['#title'] = 'title';
    values[':title'] = fields.title;
    sets.push('#title = if_not_exists(#title, :title)');
  }
  let conditionExpression: string | undefined;
  if (fields.ttlTimestamp !== undefined) {
    names['#ttl'] = 'ttl';
    values[':ttl'] = fields.ttlTimestamp;
    if (fields.forceTtlRefresh) {
      sets.push('#ttl = :ttl');
      // Guards the force-overwrite so a concurrent caller's already-healed,
      // equal-or-later anchor can never be regressed backward by this one.
      // `<=` (not `<`): two concurrent healers of the same stale anchor
      // typically compute the identical target timestamp, and `<=` lets
      // the second one succeed by re-applying the same value instead of
      // failing the condition and paying a full transaction retry for a
      // write that was never actually a regression.
      conditionExpression = 'attribute_not_exists(#ttl) OR #ttl <= :ttl';
    } else {
      sets.push('#ttl = if_not_exists(#ttl, :ttl)');
    }
  }
  return {
    Update: {
      TableName: tableName,
      Key: sessionRowKey(fields.sessionId),
      UpdateExpression: `ADD #count :n SET ${sets.join(', ')}`,
      ...(conditionExpression ? { ConditionExpression: conditionExpression } : {}),
      ExpressionAttributeNames: names,
      ExpressionAttributeValues: values,
    },
  };
}

/** True when a plain UpdateItem was turned away by its ConditionExpression. */
function isConditionRejected(error: Error): boolean {
  return classifyAwsError(error) === ErrorCode.CONDITION_CONFLICT;
}

/**
 * Strip a title this call contributed to a session row it created, when the
 * row itself could not be deleted because a concurrent append has since added
 * messages to it.
 *
 * Without this, that narrow window reopens exactly the leak C4 closes: the
 * title is derived from the first human message of an append the caller was
 * told had failed, and `if_not_exists` means nothing ever overwrites it — so
 * a row that now belongs to a different caller keeps up to 80 characters of
 * rolled-back message content.
 *
 * Both guards are load-bearing. `createdAt = :now` establishes that this call
 * created the row, and `title = :title` that the title on it is still the one
 * this call wrote — so a pre-existing title, or one a concurrent caller won
 * the `if_not_exists` race for, is never removed. A condition rejection means
 * exactly that and is not an error; anything else is.
 *
 * Accepts: `createdAt` — this call's own timestamp. `title` — the exact string
 * this call wrote, compared as a value so nothing else's title is removed.
 *
 * Returns: nothing, whether the title was removed or the guards correctly
 * refused.
 *
 * Throws: whatever the update throws other than its own condition failure.
 */
export async function removeRolledBackTitle(
  context: HistoryContext,
  sessionId: SessionId,
  createdAt: string,
  title: string,
): Promise<void> {
  try {
    await withDynamoDBRetry(
      (request) =>
        context.client.update(
          {
            TableName: context.tableName,
            Key: sessionRowKey(sessionId),
            UpdateExpression: 'REMOVE #title',
            ConditionExpression: '#c = :now AND #title = :title',
            ExpressionAttributeNames: { '#title': 'title', '#c': 'createdAt' },
            ExpressionAttributeValues: { ':now': createdAt, ':title': title },
          },
          request,
        ),
      context.retry,
    );
  } catch (error) {
    if (isConditionRejected(error as Error)) return;
    throw error;
  }
}

/** The resolved ttl anchor plus whether the persisted SESSION-row value must be force-refreshed. */
export interface TtlAnchorResult {
  ttlTimestamp: number;
  refresh: boolean;
}

/**
 * Resolve the session's creation-anchored TTL: the value already stored on the
 * SESSION item, if one exists AND is still in the future; otherwise the
 * supplied `candidate`, with `refresh: true` so the caller force-overwrites
 * the stale/missing persisted anchor instead of leaving it stuck (DynamoDB's
 * `if_not_exists` would otherwise never correct an already-expired anchor).
 * This is a strongly-consistent read, never a write, so it cannot leave a
 * metadata-only orphan row when the following append transaction fails.
 *
 * When a stale anchor is healed, only the persisted SESSION row's `ttl` is
 * force-refreshed — the message rows already written under the expired
 * anchor keep their own (already-expired) `ttl` and get swept independently
 * by DynamoDB's TTL sweep. Until that sweep runs (and until
 * `reconcileMessageCount` repairs the count), `messageCount` can therefore be
 * temporarily overstated relative to what `getMessages` actually returns.
 * This is expected, not a bug.
 *
 * Accepts: `candidate` — the anchor this append would use if the session has
 * none, already computed from the configured ttl.
 *
 * Returns: the anchor to stamp on this append's messages, and whether the
 * SESSION row's own `ttl` must be force-overwritten rather than left to
 * `if_not_exists`.
 *
 * Throws: whatever the read throws after retries.
 *
 * Guarantees: a read, never a write — so a failure of the append that follows
 * cannot leave a metadata-only orphan row behind. Strongly consistent, so an
 * anchor an earlier append committed is always seen. Two appends that start
 * together on a session that has none each propose their own candidate; the
 * append transaction's own condition is what settles which persists, so this
 * read never has to be the arbiter (see {@link buildSessionUpdate}).
 */
export async function resolveTtlAnchor(
  context: HistoryContext,
  sessionId: SessionId,
  candidate: number,
  signal?: AbortSignal,
): Promise<TtlAnchorResult> {
  const result = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: sessionRowKey(sessionId),
          ConsistentRead: true,
          ProjectionExpression: '#ttl',
          ExpressionAttributeNames: { '#ttl': 'ttl' },
        },
        request,
      ),
    retryFor(context, signal),
  );
  const ttl = (result.Item as { ttl?: number } | undefined)?.ttl;
  if (typeof ttl === 'number' && ttl > nowSeconds()) {
    return { ttlTimestamp: ttl, refresh: false };
  }
  return { ttlTimestamp: candidate, refresh: true };
}

const MAX_TITLE_LENGTH = 80;

/** The shape of a text content block in a multimodal message. */
interface TextBlock {
  type: 'text';
  text: string;
}

function isTextBlock(block: object): block is TextBlock {
  const candidate = block as { type?: string; text?: string };
  return candidate.type === 'text' && typeof candidate.text === 'string';
}

/**
 * What a stored message's `content` holds at runtime. `StoredMessageData`
 * declares it as `string`, but a multimodal message serializes its
 * `MessageContentComplex[]` blocks verbatim, so an array must be handled too.
 */
type StoredContent = string | readonly (object | string | number | boolean | null)[];

/**
 * The human-readable text of a message's `content`: the string itself, or the
 * first `text` block of a content-block array (a multimodal message carries
 * image and text blocks side by side). Undefined when neither yields text.
 */
function textOf(content: StoredContent | undefined): string | undefined {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return undefined;
  const block = content.find(
    (entry): entry is TextBlock =>
      typeof entry === 'object' && entry !== null && isTextBlock(entry),
  );
  return block?.text;
}

/**
 * Derive a session title from the first human message's text content, at most
 * {@link MAX_TITLE_LENGTH} characters including the ellipsis. Returns undefined
 * when there is no usable text.
 *
 * Truncation counts *code points*, not UTF-16 code units: slicing by index
 * could cut a surrogate pair in half, leaving a lone surrogate that no longer
 * round-trips through UTF-8. The ellipsis is also counted against the maximum
 * rather than appended past it.
 *
 * Accepts: `messages` — one append's messages, in order. The first `human` one
 * is the title's source; an append of only AI or tool messages has none, and an
 * append to an existing session produces a title that is then discarded by
 * `if_not_exists`.
 *
 * Returns: the title, or undefined when there is no usable text — no human
 * message, empty content, or a multimodal message carrying no text block.
 * Undefined means "do not write a title", not "write an empty one".
 *
 * Throws: nothing. A title is a convenience; nothing about it may fail an
 * append.
 */
export function deriveTitle(messages: StoredMessage[]): string | undefined {
  const firstHuman = messages.find((message) => message.type === 'human');
  const content = firstHuman === undefined ? undefined : textOf(firstHuman.data.content);
  if (content === undefined || content.length === 0) return undefined;
  const codePoints = [...content];
  if (codePoints.length <= MAX_TITLE_LENGTH) return content;
  return `${codePoints.slice(0, MAX_TITLE_LENGTH - 1).join('')}…`;
}

/** The per-session metadata row, updated atomically as messages are appended. */
interface SessionRow {
  PK: string;
  SK: string;
  /** Row format version; absent on rows written before it existed (see `table-schema.ts`). */
  v?: number;
  sessionId: string;
  messageCount: number;
  title?: string;
  createdAt: string;
  updatedAt: string;
  ttl?: number;
}

/** The session row's stored count, and whether the row exists at all. */
interface ObservedCount {
  exists: boolean;
  count?: number;
}

/** Read the count this repair is about to replace, strongly consistently. */
async function observeCount(
  context: HistoryContext,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<ObservedCount> {
  const result = await withDynamoDBRetry(
    (request) =>
      context.client.get(
        {
          TableName: context.tableName,
          Key: sessionRowKey(sessionId),
          ConsistentRead: true,
          ProjectionExpression: '#count',
          ExpressionAttributeNames: { '#count': 'messageCount' },
        },
        request,
      ),
    retryFor(context, signal),
  );
  if (!result.Item) return { exists: false };
  const count = result.Item.messageCount;
  return typeof count === 'number' ? { exists: true, count } : { exists: true };
}

/**
 * The condition admitting the repair only while the row still holds the count
 * it was computed against. A row written before the attribute existed carries
 * none, and pinning its *absence* is what makes the guard correct there too.
 */
function countGuard(observed: ObservedCount): {
  ConditionExpression: string;
  ExpressionAttributeValues?: Record<string, number>;
} {
  if (observed.count === undefined) {
    return {
      ConditionExpression: `attribute_exists(${PARTITION_KEY_ATTRIBUTE}) AND attribute_not_exists(#count)`,
    };
  }
  return {
    ConditionExpression: `attribute_exists(${PARTITION_KEY_ATTRIBUTE}) AND #count = :expected`,
    ExpressionAttributeValues: { ':expected': observed.count },
  };
}

/** Write the recomputed count, pinned to what the row held when it was computed. */
async function writeCount(
  context: HistoryContext,
  sessionId: SessionId,
  repair: { count: number; observed: ObservedCount },
  signal?: AbortSignal,
): Promise<void> {
  const guard = countGuard(repair.observed);
  await withDynamoDBRetry(
    (request) =>
      context.client.update(
        {
          TableName: context.tableName,
          Key: sessionRowKey(sessionId),
          UpdateExpression: 'SET #count = :count',
          ExpressionAttributeNames: { '#count': 'messageCount' },
          ExpressionAttributeValues: { ':count': repair.count, ...guard.ExpressionAttributeValues },
          ConditionExpression: guard.ConditionExpression,
        },
        request,
      ),
    retryFor(context, signal),
  );
}

/**
 * Recompute `messageCount` from the stored message rows and write it, pinned to
 * the count the row held when the recount began.
 *
 * Accepts: `sessionId` — parsed. `signal` — cancels the reads, the recount and
 * the write.
 *
 * Returns: the count written.
 *
 * Throws: `CONDITION_CONFLICT` when the session does not exist, or when it
 * changed during every one of the compare-and-swap's attempts;
 * `FORMAT_UNSUPPORTED` for a message row a newer release wrote; `VALIDATION`
 * naming `message` for a row in the message key space this package did not
 * write; whatever the reads and the write throw.
 */
export async function repairMessageCount(
  context: HistoryContext,
  sessionId: SessionId,
  signal?: AbortSignal,
): Promise<number> {
  for (let attempt = 1; attempt <= OVERWRITE_CAS_MAX_ATTEMPTS; attempt++) {
    const observed = await observeCount(context, sessionId, signal);
    if (!observed.exists) {
      throw conflictError(`Cannot reconcile messageCount: session "${sessionId}" does not exist`);
    }
    const count = await countLiveMessages(context, sessionId, signal);
    try {
      await writeCount(context, sessionId, { count, observed }, signal);
      return count;
    } catch (error) {
      if (classifyAwsError(error as Error) !== ErrorCode.CONDITION_CONFLICT) throw error;
    }
  }
  throw conflictError(
    `Cannot reconcile messageCount: session "${sessionId}" changed during every one of ` +
      `${OVERWRITE_CAS_MAX_ATTEMPTS} attempts; retry when it is quieter`,
  );
}

/**
 * Whether a row's `ttl` is an instant a session listing can both judge and
 * render.
 *
 * Neither of the two things done with it refuses a value it cannot use.
 * {@link isExpiredRow} compares it against the clock, and a non-number compares
 * `false` against every clock, so an unreadable ttl reads as *live* rather than
 * being filtered out. `expiresAt` then renders it, and `NaN`, `Infinity` and
 * anything past the ±8.64e12 seconds a `Date` spans are all numbers whose
 * `toISOString` throws `RangeError` — which failed the whole listing.
 */
function hasReadableTtl(ttl: AttributeMap[string]): boolean {
  if (ttl === undefined) return true;
  return typeof ttl === 'number' && Number.isFinite(new Date(ttl * 1000).getTime());
}

/**
 * Whether every attribute {@link summariseSession} hands back is the type this package
 * writes there.
 *
 * The identity test {@link summariseSession} makes first proves a row is a
 * session row; this proves its own attributes are usable. They are returned
 * under declared types, so a row that disagrees answers the caller with a lie
 * — `messageCount: 'many'` handed back as a number — or, for the ttl, with a
 * `RangeError`. A row this release cannot speak for is dropped the way a
 * foreign row is, never at the cost of the rest of the page.
 */
function isSummarisable(raw: AttributeMap): boolean {
  return (
    typeof raw.messageCount === 'number' &&
    typeof raw.createdAt === 'string' &&
    typeof raw.updatedAt === 'string' &&
    (raw.title === undefined || typeof raw.title === 'string') &&
    hasReadableTtl(raw.ttl)
  );
}

/**
 * The public summary of a SESSION row: the session a row describes, or
 * undefined for a foreign, malformed or expired row.
 *
 * The `sessionId` is bound to the partition the row was found in, as
 * `parseMetaRow`, `parseStoreRow` and `parseMessageRow` bind theirs.
 * Both reads that reach here select rows by something other than the partition
 * — a table scan filtered on the sort key, and a recency-index query — so
 * without the binding a row planted anywhere in the table under this adapter's
 * SESSION sort key was summarised under whatever `sessionId` it claimed, and a
 * caller taking that id to `getMessages` read a partition the row never lived
 * in.
 *
 * Accepts: `raw` — a row a listing read. `atSeconds` — the listing's clock,
 * against which an expired row is absent.
 *
 * Returns: the summary, or `undefined` for a foreign, malformed or expired row.
 *
 * Throws: `FORMAT_UNSUPPORTED` for a row a newer release wrote. It is not a
 * foreign row to skip, and summarising it under this release's rules could
 * return its attributes with a meaning they no longer have. Checked before the
 * shape, the binding and the ttl — as every other read of this package's rows
 * checks it — so a newer row is refused rather than judged against attribute
 * names it may no longer use, and the answer does not depend on the reading
 * machine's clock.
 */
export function summariseSession(
  raw: AttributeMap,
  atSeconds: number,
): SessionMetadata | undefined {
  const item = raw as SessionRow;
  assertReadableRow(item, 'session');
  if (item.SK !== SESSION_SORT_KEY || typeof item.sessionId !== 'string') return undefined;
  if (item.PK !== sessionPartition(item.sessionId)) return undefined;
  if (!isSummarisable(raw) || isExpiredRow(item, atSeconds)) return undefined;
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
 * Where a history row sits in the recency index, for a row written before the
 * index existed.
 *
 * Accepts: `row` — any row of the table.
 *
 * Returns: a SESSION row's identity — its session id, at its own `updatedAt` —
 * or `undefined` for a message row or a row of another adapter.
 *
 * Throws: nothing.
 */
export function sessionIndexTarget(row: AttributeMap): IndexTarget | undefined {
  const pk = typeof row.PK === 'string' ? row.PK : '';
  const sk = typeof row.SK === 'string' ? row.SK : '';
  if (!pk.startsWith(historyPartitionPrefix())) return undefined;
  return sk.endsWith('SESSION') && typeof row.sessionId === 'string'
    ? { tag: 'SESS', id: row.sessionId, at: backfilledAt(row.updatedAt) }
    : undefined;
}
