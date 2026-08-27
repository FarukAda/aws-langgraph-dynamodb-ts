import { getCancellationReasons } from '../../../../src/shared/dynamodb/cancellation';

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
