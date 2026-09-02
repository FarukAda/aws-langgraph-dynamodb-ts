import {
  isConditionalCheckFailed,
  rejectedItem,
  REVISION_ATTRIBUTE,
  revisionGuard,
} from '../../../../src/shared/dynamodb/conditional-put';

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
    expect(isConditionalCheckFailed({ name: 'ConditionalCheckFailedException' })).toBe(true);
    expect(isConditionalCheckFailed({ name: 'ProvisionedThroughputExceededException' })).toBe(
      false,
    );
    expect(isConditionalCheckFailed({})).toBe(false);
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
