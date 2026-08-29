import {
  isConditionalCheckFailed,
  REVISION_ATTRIBUTE,
  revisionGuard,
} from '../../../../src/shared/dynamodb/conditional-put';

describe('revisionGuard', () => {
  it('admits only a create when no row was observed', () => {
    expect(revisionGuard(REVISION_ATTRIBUTE, { exists: false })).toEqual({
      ConditionExpression: 'attribute_not_exists(PK)',
    });
  });

  it('pins the observed revision when the row carries one', () => {
    expect(revisionGuard(REVISION_ATTRIBUTE, { exists: true, revision: 'r1' })).toEqual({
      ConditionExpression: '#rev = :rev',
      ExpressionAttributeNames: { '#rev': 'rev' },
      ExpressionAttributeValues: { ':rev': 'r1' },
    });
  });

  it('pins the absence of a revision for a row written before 0.9.0', () => {
    expect(revisionGuard(REVISION_ATTRIBUTE, { exists: true })).toEqual({
      ConditionExpression: 'attribute_not_exists(#rev)',
      ExpressionAttributeNames: { '#rev': 'rev' },
    });
  });

  it('names whichever attribute the caller uses as its revision', () => {
    // The checkpointer's special rows already carry a per-call ULID in
    // `writeGroup`, so they need no new attribute.
    expect(revisionGuard('writeGroup', { exists: true, revision: 'g1' })).toEqual({
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
