import { expectTypeOf } from 'expect-type';

import {
  type AnyDynamoDBLangGraphError,
  DynamoDBLangGraphError,
  ErrorCode,
  isDynamoDBLangGraphError,
} from '../../src/index';

/**
 * Under `strict`, a `catch` clause binds `unknown`. The guard is documented as
 * the first thing a caller writes inside one, so it has to accept that value
 * as it is: typed `Error`, it failed to compile there (TS2345) without a cast.
 */
describe('isDynamoDBLangGraphError', () => {
  it('takes whatever a catch clause binds, with no cast', () => {
    expectTypeOf(isDynamoDBLangGraphError).parameter(0).toEqualTypeOf<unknown>();
  });

  it('narrows an unknown value to the library error union', () => {
    const caught: unknown = new DynamoDBLangGraphError('x', ErrorCode.VALIDATION);
    if (isDynamoDBLangGraphError(caught)) {
      expectTypeOf(caught).toEqualTypeOf<AnyDynamoDBLangGraphError>();
    }
    expect(isDynamoDBLangGraphError(caught)).toBe(true);
    expect(isDynamoDBLangGraphError('x')).toBe(false);
    expect(isDynamoDBLangGraphError(null)).toBe(false);
  });
});
