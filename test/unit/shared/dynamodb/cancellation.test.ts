import type { AttributeValue } from '@aws-sdk/client-dynamodb';

import {
  type CancellationReason,
  conditionalCheckFailure,
  getCancellationReasons,
} from '../../../../src/shared/dynamodb/cancellation';

/** The raw row DynamoDB attaches to the item whose condition failed. */
const REJECTED_ROW: Record<string, AttributeValue> = { rev: { S: 'other' } };

/** A cancelled transaction, as the SDK delivers one. */
function cancelled(reasons: CancellationReason[]): Error {
  return Object.assign(new Error('cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: reasons,
  });
}

describe('getCancellationReasons', () => {
  it('returns the CancellationReasons array when present', () => {
    const error = Object.assign(new Error('cancelled'), {
      CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }],
    });
    expect(getCancellationReasons(error)).toEqual([
      { Code: 'None' },
      { Code: 'ConditionalCheckFailed' },
    ]);
  });

  it('returns undefined when the error carries no CancellationReasons', () => {
    expect(getCancellationReasons(new Error('plain'))).toBeUndefined();
  });
});

describe('conditionalCheckFailure', () => {
  it('returns the reason of a transaction its guard turned away, row included', () => {
    const reason = conditionalCheckFailure(
      cancelled([{ Code: 'ConditionalCheckFailed', Item: REJECTED_ROW }]),
    );
    expect(reason).toEqual({ Code: 'ConditionalCheckFailed', Item: REJECTED_ROW });
  });

  it('looks past the items that were not the cause', () => {
    expect(
      conditionalCheckFailure(cancelled([{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }])),
    ).toEqual({ Code: 'ConditionalCheckFailed' });
  });

  it('is undefined when a conflict cancelled the transaction instead', () => {
    expect(conditionalCheckFailure(cancelled([{ Code: 'TransactionConflict' }]))).toBeUndefined();
  });

  it('is undefined when a second item failed for its own reason', () => {
    // Two causes: this write was not simply turned away by its own guard, so
    // reporting a guard rejection would hide the other failure.
    expect(
      conditionalCheckFailure(
        cancelled([{ Code: 'ConditionalCheckFailed' }, { Code: 'ValidationError' }]),
      ),
    ).toBeUndefined();
  });

  it('is undefined for the exception name spelled as a reason code', () => {
    expect(
      conditionalCheckFailure(cancelled([{ Code: 'ConditionalCheckFailedException' }])),
    ).toBeUndefined();
  });

  it('is undefined when the error is no cancellation at all', () => {
    expect(conditionalCheckFailure(new Error('plain'))).toBeUndefined();
  });

  it('is undefined for a cancellation carrying no reasons', () => {
    expect(conditionalCheckFailure(cancelled([]))).toBeUndefined();
  });
});
