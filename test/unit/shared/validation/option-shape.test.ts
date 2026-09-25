import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  allKeysOf,
  assertObjectShape,
  assertShape,
  parseShape,
  isObjectShape,
} from '../../../../src/shared/validation/option-shape';
import { assertClientChoice } from '../../../../src/shared/validation/options';

interface Sample {
  alpha?: number;
  beta?: string;
}

const SAMPLE_KEYS = allKeysOf<Sample>({ alpha: 'alpha', beta: 'beta' });

describe('allKeysOf', () => {
  it('returns every key of the type, in the literal s order', () => {
    expect(SAMPLE_KEYS).toEqual(['alpha', 'beta']);
  });
});

describe('assertShape', () => {
  it('accepts an object using any subset of the known keys, including none', () => {
    expect(() => assertShape({}, SAMPLE_KEYS, 'sample')).not.toThrow();
    expect(() => assertShape({ alpha: 1 }, SAMPLE_KEYS, 'sample')).not.toThrow();
    expect(() => assertShape({ alpha: 1, beta: 'x' }, SAMPLE_KEYS, 'sample')).not.toThrow();
  });

  /** A misspelt key is otherwise ignored and the caller runs on a default. */
  it('names the unknown key and the options it would accept', () => {
    try {
      assertShape({ alpah: 1 }, SAMPLE_KEYS, 'sample');
      throw new Error('should have thrown');
    } catch (error) {
      const typed = error as { code: ErrorCode; context: { field?: string }; message: string };
      expect(typed.code).toBe(ErrorCode.VALIDATION);
      expect(typed.context.field).toBe('sample.alpah');
      expect(typed.message).toContain('alpha, beta');
    }
  });

  it('refuses a value that is not an object at all', () => {
    for (const value of [null, [], 'x', 7]) {
      expect(() => assertShape(value as never, SAMPLE_KEYS, 'sample')).toThrow(
        /sample must be an object/,
      );
    }
  });
});

describe('assertObjectShape', () => {
  it('accepts a plain object, including one with no keys', () => {
    expect(() => assertObjectShape({}, 'thing')).not.toThrow();
    expect(() => assertObjectShape({ a: 1 }, 'thing')).not.toThrow();
  });

  it('refuses a non-object, null and an array, naming the field', () => {
    for (const value of [null, [], 'x', 7]) {
      expect(() => assertObjectShape(value as never, 'thing')).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'thing' } }),
      );
    }
  });
});

describe('isObjectShape', () => {
  it('is true for exactly the values assertObjectShape accepts', () => {
    for (const value of [{}, { a: 1 }]) expect(isObjectShape(value)).toBe(true);
    for (const value of [undefined, null, [], 'x', 7]) {
      expect(isObjectShape(value as never)).toBe(false);
    }
  });
});

describe('parseShape', () => {
  it('returns the value unchanged when every key is known', () => {
    const value = { alpha: 1 };
    expect(parseShape(value, SAMPLE_KEYS, 'sample')).toBe(value);
  });

  it('throws for an unknown key, same as assertShape', () => {
    expect(() => parseShape({ alpah: 1 }, SAMPLE_KEYS, 'sample')).toThrow(
      expect.objectContaining({ context: { field: 'sample.alpah' } }),
    );
  });
});

describe('assertClientChoice', () => {
  it('accepts either way of getting a client, or neither', () => {
    expect(() => assertClientChoice({})).not.toThrow();
    expect(() => assertClientChoice({ client: {} as never })).not.toThrow();
    expect(() => assertClientChoice({ clientConfig: { region: 'eu-west-1' } })).not.toThrow();
    expect(() => assertClientChoice({ createClient: (() => ({})) as never })).not.toThrow();
  });

  /** An injected client is used as-is, so the configuration beside it would be ignored. */
  it('refuses a client alongside a configuration for building one', () => {
    expect(() =>
      assertClientChoice({ client: {} as never, clientConfig: { region: 'eu-west-1' } }),
    ).toThrow(/either `client` or `clientConfig`/);
    expect(() =>
      assertClientChoice({ client: {} as never, createClient: (() => ({})) as never }),
    ).toThrow(/either `client` or `clientConfig`/);
  });

  /**
   * The keys are the AWS SDK's, so only the shape is checked: a key this
   * package was not compiled with must still reach the SDK.
   */
  it('refuses a clientConfig that is not an object, naming it, and never checks its keys', () => {
    for (const clientConfig of [null, [], 'x', 7]) {
      expect(() => assertClientChoice({ clientConfig: clientConfig as never })).toThrow(
        expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'clientConfig' } }),
      );
    }
    expect(() =>
      assertClientChoice({ clientConfig: { newerSdkOption: true } as never }),
    ).not.toThrow();
  });

  it('names `client` on the error it raises', () => {
    try {
      assertClientChoice({ client: {} as never, clientConfig: {} });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as { context: { field?: string } }).context.field).toBe('client');
    }
  });
});
