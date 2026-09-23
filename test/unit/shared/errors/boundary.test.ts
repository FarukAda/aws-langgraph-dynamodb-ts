import {
  guardPublic,
  guardPublicIterable,
  toPublicError,
} from '../../../../src/shared/errors/boundary';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { validationError } from '../../../../src/shared/errors/errors';

function raw(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

describe('toPublicError', () => {
  it('returns a library error unchanged', () => {
    const validation = validationError('bad');
    expect(toPublicError(validation, 'op')).toBe(validation);
  });

  it('wraps anything else with the code the classifier assigns, naming the operation', () => {
    const error = raw('InternalServerError', 'boom');
    expect(toPublicError(error, 'store.batch')).toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.SERVICE_UNAVAILABLE,
      context: { operation: 'store.batch', awsErrorName: 'InternalServerError' },
      cause: error,
    });
  });

  it('normalises a non-Error rejection value before wrapping it as unexpected', () => {
    expect(toPublicError('plain string' as never, 'op')).toMatchObject({
      code: ErrorCode.UNEXPECTED_ERROR,
      message: expect.stringContaining('plain string'),
    });
  });
});

describe('guardPublic', () => {
  it('passes a resolved value through', async () => {
    await expect(guardPublic('op', () => Promise.resolve(42))).resolves.toBe(42);
  });

  it('wraps a raw rejection and passes a library rejection through', async () => {
    await expect(
      guardPublic('op', () => {
        throw raw('ThrottlingException');
      }),
    ).rejects.toMatchObject({ name: 'DynamoDBLangGraphError', code: ErrorCode.THROTTLED });
    const validation = validationError('bad');
    await expect(
      guardPublic('op', () => {
        throw validation;
      }),
    ).rejects.toBe(validation);
  });
});

describe('guardPublicIterable', () => {
  it('yields every item and wraps a failure raised mid-iteration', async () => {
    /**
     * `guardPublicIterable`'s `source` parameter is typed `AsyncGenerator`; a
     * plain `function*` cannot satisfy that (no non-async function type
     * does, unlike a plain `Promise<T>`-returning function). This generator
     * only ever yields plain numbers, never a thenable, so `require-await`
     * has nothing else to accept in place of a real `await`; the one below
     * resolves an already-resolved value and changes nothing a caller can
     * observe.
     */
    async function* source(): AsyncGenerator<number> {
      await Promise.resolve();
      yield 1;
      yield 2;
      throw raw('ThrottlingException', 'late');
    }
    const seen: number[] = [];
    await expect(
      (async () => {
        for await (const n of guardPublicIterable('saver.list', source())) seen.push(n);
      })(),
    ).rejects.toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.THROTTLED,
      context: { operation: 'saver.list', awsErrorName: 'ThrottlingException' },
    });
    expect(seen).toEqual([1, 2]);
  });

  it('closes the source when the consumer stops early', async () => {
    let finished = false;
    /** Same reasoning as the `source` above. */
    async function* source(): AsyncGenerator<number> {
      await Promise.resolve();
      try {
        yield 1;
        yield 2;
      } finally {
        finished = true;
      }
    }
    for await (const n of guardPublicIterable('op', source())) {
      if (n === 1) break;
    }
    expect(finished).toBe(true);
  });
});
