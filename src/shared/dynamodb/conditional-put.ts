import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { unmarshall } from '@aws-sdk/util-dynamodb';

import type { DocItem } from './types';

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
 */
export function revisionGuard(attribute: string, observed: ObservedRow): RevisionGuard {
  if (!observed.exists)
    return { ...RETURN_REJECTED_ROW, ConditionExpression: 'attribute_not_exists(PK)' };
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

/**
 * True when the guard rejected a write — NOT evidence a competitor won: a
 * `PutCommand` retried after its response was lost can re-hit its own
 * committed row and fail identically; the two cases are indistinguishable.
 */
export function isConditionalCheckFailed(error: { name?: string }): boolean {
  return error.name === 'ConditionalCheckFailedException';
}

/**
 * The row that turned a conditional write away, when DynamoDB attached it
 * (`ReturnValuesOnConditionCheckFailure: 'ALL_OLD'`). Verified against real
 * DynamoDB: the document client does not unmarshall an *error* payload the way
 * it unmarshalls a response, so the item arrives in raw AttributeValue form and
 * is unmarshalled here. Undefined when the rejection carries no item — the row
 * was deleted between the observation and the write — in which case the caller
 * falls back to a read.
 */
export function rejectedItem(error: Error): DocItem | undefined {
  const raw = (error as { Item?: Record<string, AttributeValue> }).Item;
  return raw === undefined ? undefined : (unmarshall(raw) as DocItem);
}
