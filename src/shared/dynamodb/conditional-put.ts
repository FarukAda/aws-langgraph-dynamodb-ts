import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import { classifyAwsError } from '../errors/classify';
import { ErrorCode } from '../errors/error-code';
import { conditionalCheckFailure } from './cancellation';
import type { DocItem } from './client';
import { PARTITION_KEY_ATTRIBUTE } from './table-schema';

/**
 * Attribute holding a row's revision token on adapters that need one. The
 * checkpointer's special writes reuse their existing per-call `writeGroup`
 * instead, so `revisionGuard` takes the attribute name rather than assuming it.
 */
export const REVISION_ATTRIBUTE = 'rev';

/**
 * Compare-and-swap attempts before a caller gives up and overwrites
 * unconditionally. Kept small on purpose: DynamoDB charges write capacity for a
 * *failed* conditional write too, sized on the existing item, so an aggressive
 * loop turns contention into cost. Three attempts settle every realistic race,
 * and the fallback is exactly the pre-0.9.0 behaviour rather than an error.
 */
export const OVERWRITE_CAS_MAX_ATTEMPTS = 3;

/** What a caller saw at the row before it tried to overwrite it. */
export interface ObservedRow {
  exists: boolean;
  revision?: string;
}

/**
 * Condition fragments to spread into a `PutCommand` input. Every guard asks
 * DynamoDB to attach the existing row to a rejection, so a compare-and-swap
 * that loses can re-pin from the exception (see {@link rejectedItem}) instead
 * of spending a second strongly-consistent read.
 */
export interface RevisionGuard {
  ConditionExpression: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, string>;
  ReturnValuesOnConditionCheckFailure: 'ALL_OLD';
}

const RETURN_REJECTED_ROW = { ReturnValuesOnConditionCheckFailure: 'ALL_OLD' } as const;

/**
 * Build the condition admitting a write only while the row still holds the
 * revision this caller observed.
 *
 * Without it, two concurrent overwrites both read the same previous payload
 * descriptor, both commit their own nonced upload, and both delete that same
 * previous object — leaving the loser's upload orphaned with nothing left
 * recording that it ever existed. A post-commit read-back cannot repair that,
 * because neither writer can learn of an object it never saw; only refusing the
 * second write until it re-reads can.
 *
 * A row with no revision attribute was written before 0.9.0. Pinning its
 * *absence* is what makes the swap correct across an upgrade: the first writer
 * to touch such a row stamps one, and any racer still holding the pre-upgrade
 * observation is turned away.
 *
 * Accepts: `attribute` — the revision attribute's name, since the checkpointer
 * reuses its `writeGroup` rather than carrying a second one. `observed` — the
 * three states a caller can have seen: no row, a row with no revision, a row
 * with one.
 *
 * Returns: the condition fragments for a `PutCommand`, one per state —
 * `attribute_not_exists(PK)`, `attribute_not_exists(<attribute>)`, and
 * equality. Every one asks DynamoDB to attach the existing row to a rejection,
 * so a swap that loses re-pins from the exception instead of spending a second
 * strongly-consistent read.
 *
 * Throws: nothing.
 *
 * Guarantees: it pins the revision the caller observed — a value, its absence,
 * or the row's own absence — and nothing else about the row. A revision is
 * drawn afresh by every write that replaces the row (`randomUUID()` for a
 * store record, the call's own `writeGroup` for a special row) and nothing
 * restores a spent one, so a **satisfied** guard proves that nothing replaced
 * the row between the caller's read and this write: the row overwritten is the
 * row observed, still naming the descriptor the caller read off it. That is
 * what makes it safe to release the payload this write superseded — the
 * caller is holding the descriptor the row really named, not a stale copy of
 * one a racer has already replaced and released. An update that leaves the
 * revision alone can still have touched the row in between — the recency-index
 * backfill is the one such write in this package, and it adds index keys and
 * nothing else — so what the guard pins is the row's identity, not every byte
 * of it.
 *
 * A **rejected** guard proves the mirror and no more: the row is not the one
 * observed. It is never evidence that a competitor won, because a write whose
 * acknowledgement was lost can be turned away by the row it committed itself
 * — see {@link isConditionalCheckFailed} — and it carries no idempotency for a
 * retry either, since a rejected attempt commits nothing for a token to be
 * answered from.
 */
export function revisionGuard(attribute: string, observed: ObservedRow): RevisionGuard {
  if (!observed.exists)
    return {
      ...RETURN_REJECTED_ROW,
      ConditionExpression: `attribute_not_exists(${PARTITION_KEY_ATTRIBUTE})`,
    };
  if (observed.revision === undefined) {
    return {
      ...RETURN_REJECTED_ROW,
      ConditionExpression: 'attribute_not_exists(#rev)',
      ExpressionAttributeNames: { '#rev': attribute },
    };
  }
  return {
    ...RETURN_REJECTED_ROW,
    ConditionExpression: '#rev = :rev',
    ExpressionAttributeNames: { '#rev': attribute },
    ExpressionAttributeValues: { ':rev': observed.revision },
  };
}

/** The field a payload descriptor carries the id of the write that produced it in. */
export const WRITE_ID_ATTRIBUTE = 'writeId';

/**
 * Build the condition admitting a delete only while the row still carries the
 * per-write id the reader observed on it.
 *
 * A partition-wide delete reads a partition and then deletes what it saw. A row
 * rewritten in between was acknowledged to its writer and is erased anyway, and
 * the object it named is released — which this turns into a refusal the pass
 * reports instead. The id is the write's own, never recomputed from the row's
 * state, so nothing can restore it and no second writer can arrive at it.
 *
 * Accepts: `attribute` — the attribute the id lives on, top-level for a row
 * that carries one (a pending write's `writeGroup`, a session row's own id) and
 * the payload attribute otherwise. `id` — the id the read observed; a row
 * observed *without* one is deleted unconditionally rather than pinned, so this
 * is never called for it. `field` — the field inside the attribute, which turns
 * the condition into a document path over a descriptor; omitted for a
 * top-level pin.
 *
 * Returns: the condition fragments for a `DeleteCommand`, asking DynamoDB to
 * attach the existing row to a rejection so the refusal can be told from a row
 * that was already gone with no second read.
 *
 * Throws: nothing.
 *
 * Guarantees: one equality and nothing else. A document path over an attribute
 * that is absent, or present without the field, evaluates false rather than
 * failing the request, so one shape covers an offloaded row, an inline one and
 * a row a racer has rewritten into either.
 *
 * What a satisfied guard proves is the delete's counterpart of
 * {@link revisionGuard}'s: the row removed is the row the partition read saw,
 * not a replacement a later write left at the same key — which is what makes
 * the object that read recorded against it the right one to release. A
 * rejection means the row now carries some other write's id, and this pass
 * leaves it in place and reports it rather than re-pinning, because a row it
 * never read is not its to delete.
 */
export function writeIdGuard(attribute: string, id: string, field?: string): RevisionGuard {
  const names: Record<string, string> = { '#pin': attribute };
  if (field !== undefined) names['#field'] = field;
  return {
    ...RETURN_REJECTED_ROW,
    ConditionExpression: field === undefined ? '#pin = :pin' : '#pin.#field = :pin',
    ExpressionAttributeNames: names,
    ExpressionAttributeValues: { ':pin': id },
  };
}

/**
 * Whether a conditional write was turned away by its guard.
 *
 * The same rejection has two shapes, because a `PutItem` reports it as an
 * exception of its own while a `TransactWriteItems` reports it as one
 * cancellation reason among one per item. Both are the same event to a caller,
 * so both answer true here and neither is a caller's business to tell apart.
 *
 * Accepts: `error` — any error; the exception's name and, for a cancelled
 * transaction, its reasons are read.
 *
 * Returns: true for `ConditionalCheckFailedException`, and for a cancellation
 * whose one cause is a `ConditionalCheckFailed` reason, as the classifier
 * decides both.
 *
 * Throws: nothing.
 *
 * Guarantees: **not** evidence that a competitor won. A `PutCommand` retried
 * after its response was lost can re-hit the row it wrote itself and fail
 * identically, and the two are indistinguishable from the rejection alone —
 * which is why every caller reads the row back before deleting anything.
 */
export function isConditionalCheckFailed(error: Error): boolean {
  return classifyAwsError(error) === ErrorCode.CONDITION_CONFLICT;
}

/**
 * The row that turned a conditional write away, when DynamoDB attached it
 * (`ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`). Verified against real
 * DynamoDB: the document client does not unmarshall an *error* payload the way
 * it unmarshalls a response, so the item arrives in raw AttributeValue form and
 * is unmarshalled here. Undefined when the rejection carries no item — the row
 * was deleted between the observation and the write — in which case the caller
 * falls back to a read.
 *
 * A cancelled transaction attaches the same row to the cancellation reason of
 * the item whose condition failed, rather than to the error itself, and leaves
 * it in the same raw form — so there is one place more to look and still one
 * unmarshalling.
 *
 * Accepts: `error` — any error; only a rejection from a guard built by
 * {@link revisionGuard} carries the item.
 *
 * Returns: the row as a plain document, or undefined.
 *
 * Throws: whatever `unmarshall` rejects for an item that is not in
 * AttributeValue form.
 */
export function rejectedItem(error: Error): DocItem | undefined {
  const attached = (error as { Item?: Record<string, AttributeValue> }).Item;
  const raw = attached ?? conditionalCheckFailure(error)?.Item;
  return raw === undefined ? undefined : (unmarshall(raw) as DocItem);
}
