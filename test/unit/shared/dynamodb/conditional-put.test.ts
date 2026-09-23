import type { CancellationReason } from '../../../../src/shared/dynamodb/cancellation';
import {
  isConditionalCheckFailed,
  rejectedItem,
  revisionGuard,
  WRITE_ID_ATTRIBUTE,
  writeIdGuard,
} from '../../../../src/shared/dynamodb/conditional-put';
import { isRetryableError } from '../../../../src/shared/dynamodb/retry-classifier';
import { DEFAULT_RETRYABLE_ERRORS } from '../../../../src/shared/errors/classify';

/** A shared module's test has no business with the store's row; a sample name suffices. */
const REVISION_ATTRIBUTE = 'rev';

/** A cancelled transaction, as the SDK delivers one. */
function cancelled(reasons: CancellationReason[]): Error {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: reasons,
  });
}

describe('revisionGuard', () => {
  it('admits only a create when no row was observed', () => {
    expect(revisionGuard(REVISION_ATTRIBUTE, { exists: false })).toEqual({
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      ConditionExpression: 'attribute_not_exists(PK)',
    });
  });

  it('pins the observed revision when the row carries one', () => {
    expect(revisionGuard(REVISION_ATTRIBUTE, { exists: true, revision: 'r1' })).toEqual({
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': 'rev' },
      ExpressionAttributeValues: { ':rev': 'r1' },
    });
  });

  it('pins the absence of a revision for a row written before 0.9.0', () => {
    expect(revisionGuard(REVISION_ATTRIBUTE, { exists: true })).toEqual({
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      ConditionExpression: 'attribute_not_exists(#rev)',
      ExpressionAttributeNames: { '#rev': 'rev' },
    });
  });

  it('names whichever attribute the caller uses as its revision', () => {
    // The checkpointer's special rows already carry a per-call ULID in
    // `writeGroup`, so they need no new attribute.
    expect(revisionGuard('writeGroup', { exists: true, revision: 'g1' })).toEqual({
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': 'writeGroup' },
      ExpressionAttributeValues: { ':rev': 'g1' },
    });
  });
});

describe('isConditionalCheckFailed', () => {
  it('matches DynamoDB conditional rejection by name, not instanceof', () => {
    expect(
      isConditionalCheckFailed(
        Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' }),
      ),
    ).toBe(true);
    expect(
      isConditionalCheckFailed(
        Object.assign(new Error('x'), { name: 'ProvisionedThroughputExceededException' }),
      ),
    ).toBe(false);
    expect(isConditionalCheckFailed(new Error('x'))).toBe(false);
  });
});

describe('revisionGuard returns the rejected row (DDB-07)', () => {
  it('asks DynamoDB to attach the existing item to every rejection', () => {
    for (const observed of [
      { exists: false },
      { exists: true },
      { exists: true, revision: 'r1' },
    ]) {
      expect(revisionGuard('rev', observed).ReturnValuesOnConditionCheckFailure).toBe('ALL_OLD');
    }
  });
});

describe('rejectedItem (DDB-07)', () => {
  it('unmarshalls the raw AttributeValue item a rejection carries', () => {
    const error = Object.assign(new Error('rejected'), {
      name: 'ConditionalCheckFailedException',
      Item: {
        rev: { S: 'other' },
        createdAt: { S: 'c' },
        value: {
          M: {
            location: { S: 'INLINE' },
            serdeType: { S: 'json' },
            compressed: { BOOL: false },
            bytes: { B: new Uint8Array([1]) },
          },
        },
      },
    });
    expect(rejectedItem(error)).toEqual({
      rev: 'other',
      createdAt: 'c',
      value: {
        location: 'INLINE',
        serdeType: 'json',
        compressed: false,
        bytes: new Uint8Array([1]),
      },
    });
  });

  it('is undefined when the rejection carries no item', () => {
    expect(
      rejectedItem(Object.assign(new Error('x'), { name: 'ConditionalCheckFailedException' })),
    ).toBeUndefined();
  });
});

describe('isConditionalCheckFailed reads a cancelled transaction (T3)', () => {
  it('matches a cancellation whose one reason is a conditional check failure', () => {
    expect(isConditionalCheckFailed(cancelled([{ Code: 'ConditionalCheckFailed' }]))).toBe(true);
  });

  it('keeps the reason code and the exception name apart', () => {
    // 'ConditionalCheckFailed' is a cancellation reason code and
    // 'ConditionalCheckFailedException' an error name; neither is valid in the
    // other's place, and the two readings must not be crossed.
    expect(
      isConditionalCheckFailed(Object.assign(new Error('x'), { name: 'ConditionalCheckFailed' })),
    ).toBe(false);
    expect(isConditionalCheckFailed(cancelled([{ Code: 'ConditionalCheckFailedException' }]))).toBe(
      false,
    );
  });

  it('is false for a cancellation a conflict caused', () => {
    expect(isConditionalCheckFailed(cancelled([{ Code: 'TransactionConflict' }]))).toBe(false);
  });

  it('is false for a cancellation carrying no reasons', () => {
    expect(isConditionalCheckFailed(cancelled([]))).toBe(false);
  });
});

describe('rejectedItem reads a cancelled transaction (T3)', () => {
  it('unmarshalls the raw row attached to the rejected item', () => {
    const error = cancelled([
      { Code: 'None' },
      { Code: 'ConditionalCheckFailed', Item: { rev: { S: 'other' }, writeGroup: { S: 'g2' } } },
    ]);
    expect(rejectedItem(error)).toEqual({ rev: 'other', writeGroup: 'g2' });
  });

  it('is undefined when the rejected item carries no row', () => {
    expect(rejectedItem(cancelled([{ Code: 'ConditionalCheckFailed' }]))).toBeUndefined();
  });
});

describe('a cancelled guard rejection is classified as one always was (T3)', () => {
  it('recognises the rejection and still refuses to retry it', () => {
    const error = cancelled([{ Code: 'ConditionalCheckFailed' }]);
    expect(isConditionalCheckFailed(error)).toBe(true);
    expect(isRetryableError(error, DEFAULT_RETRYABLE_ERRORS)).toBe(false);
  });

  it('leaves both shapes a conflict arrives in retryable, and neither a rejection', () => {
    const shapes = [
      cancelled([{ Code: 'TransactionConflict' }]),
      Object.assign(new Error('conflict'), { name: 'TransactionConflictException' }),
    ];
    for (const error of shapes) {
      expect(isConditionalCheckFailed(error)).toBe(false);
      expect(isRetryableError(error, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
    }
  });

  it('keeps a reason-less cancellation non-retryable and no rejection', () => {
    const error = cancelled([]);
    expect(isConditionalCheckFailed(error)).toBe(false);
    expect(isRetryableError(error, DEFAULT_RETRYABLE_ERRORS)).toBe(false);
  });
});

describe('writeIdGuard', () => {
  it('pins a top-level attribute by equality, and attaches the row to a rejection', () => {
    expect(writeIdGuard('writeGroup', 'g1')).toEqual({
      ConditionExpression: '#pin = :pin',
      ExpressionAttributeNames: { '#pin': 'writeGroup' },
      ExpressionAttributeValues: { ':pin': 'g1' },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
  });

  it('pins a descriptor through a document path over the attribute that holds it', () => {
    expect(writeIdGuard('metadata', 'w1', WRITE_ID_ATTRIBUTE)).toEqual({
      ConditionExpression: '#pin.#field = :pin',
      ExpressionAttributeNames: { '#pin': 'metadata', '#field': 'writeId' },
      ExpressionAttributeValues: { ':pin': 'w1' },
      ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
    });
  });

  /**
   * One shape, no second clause: a row observed *without* an id is deleted
   * unconditionally rather than pinned on absence, so an absence test here
   * would be the first step back to a rule with branches.
   */
  it('never emits an absence check, whichever place it pins', () => {
    const guards = [writeIdGuard('writeGroup', 'g1'), writeIdGuard('value', 'w1', 'writeId')];
    for (const guard of guards)
      expect(guard.ConditionExpression).not.toContain('attribute_not_exists');
  });
});
