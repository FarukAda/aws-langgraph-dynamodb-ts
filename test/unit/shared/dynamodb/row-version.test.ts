import {
  assertReadableRow,
  isReadableRow,
  ROW_FORMAT_VERSION,
  rowVersionOf,
  SUPPORTED_ROW_FORMAT_VERSION,
  withRowVersion,
} from '../../../../src/shared/dynamodb/row-version';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

describe('rowVersionOf', () => {
  /**
   * A row without the attribute predates it, and `0` is the version whose
   * rules applied when it was written. Before this existed, "written by an
   * older version" was inferred from which attributes happened to be missing.
   */
  it('reads a row without the attribute as version 0', () => {
    expect(rowVersionOf({})).toBe(0);
  });

  it('reads the stamped version', () => {
    expect(rowVersionOf({ v: 1 })).toBe(1);
    expect(rowVersionOf({ v: 7 })).toBe(7);
  });

  it('treats a non-numeric value as version 0 rather than trusting it', () => {
    expect(rowVersionOf({ v: 'one' } as never)).toBe(0);
  });
});

describe('assertReadableRow', () => {
  it('accepts every version up to the supported one', () => {
    for (let version = 0; version <= SUPPORTED_ROW_FORMAT_VERSION; version++) {
      expect(() => assertReadableRow({ v: version }, 'checkpoint')).not.toThrow();
    }
  });

  /**
   * Guessing at a shape this version does not know is how a reader returns a
   * checkpoint with silently missing state, so the caller sees an error naming
   * the remedy instead.
   */
  it('refuses a row from a newer version, naming the row kind and the remedy', () => {
    try {
      assertReadableRow({ v: SUPPORTED_ROW_FORMAT_VERSION + 1 }, 'store item');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe(ErrorCode.FORMAT_UNSUPPORTED);
      expect((error as Error).message).toMatch(/store item/);
      expect((error as Error).message).toMatch(/upgrade/);
    }
  });

  it('isReadableRow answers the same question without throwing', () => {
    expect(isReadableRow({})).toBe(true);
    expect(isReadableRow({ v: SUPPORTED_ROW_FORMAT_VERSION })).toBe(true);
    expect(isReadableRow({ v: SUPPORTED_ROW_FORMAT_VERSION + 1 })).toBe(false);
  });
});

describe('withRowVersion', () => {
  it('stamps the current version without disturbing the item', () => {
    expect(withRowVersion({ PK: 'p', SK: 's' })).toEqual({
      PK: 'p',
      SK: 's',
      v: ROW_FORMAT_VERSION,
    });
  });
});
