import { drainAsyncFailures, recordUnhandledRejection } from '../../shared/helpers/async-failures';

describe('the strict-async harness', () => {
  it('turns a recorded unhandled rejection into a failure naming it', () => {
    recordUnhandledRejection(new Error('lost'));
    expect(() => drainAsyncFailures()).toThrow(/unhandled rejection: Error: lost/);
  });

  it('is empty again after draining', () => {
    expect(() => drainAsyncFailures()).not.toThrow();
  });
});
