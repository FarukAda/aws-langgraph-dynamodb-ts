import {
  guardPublic,
  guardPublicIterable,
  toPublicError,
} from '../../../../src/shared/errors/boundary';
import { ValidationError } from '../../../../src/shared/errors/errors';

function raw(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

describe('toPublicError', () => {
  it('returns a library error unchanged', () => {
    const validation = new ValidationError('bad');
    expect(toPublicError(validation, 'op')).toBe(validation);
  });

  it('wraps anything else in an UpstreamError naming the operation', () => {
    const error = raw('InternalServerError', 'boom');
    expect(toPublicError(error, 'store.batch')).toMatchObject({
      name: 'UpstreamError',
      upstreamName: 'InternalServerError',
      context: { operation: 'store.batch' },
      cause: error,
    });
  });

  it('normalises a non-Error rejection value before wrapping it', () => {
    expect(toPublicError('plain string' as never, 'op')).toMatchObject({
      name: 'UpstreamError',
      message: expect.stringContaining('plain string'),
    });
  });
});

describe('guardPublic', () => {
  it('passes a resolved value through', async () => {
    await expect(guardPublic('op', async () => await Promise.resolve(42))).resolves.toBe(42);
  });

  it('wraps a raw rejection and passes a library rejection through', async () => {
    await expect(
      guardPublic('op', async () => {
        await Promise.resolve();
        throw raw('ThrottlingException');
      }),
    ).rejects.toMatchObject({ name: 'UpstreamError', upstreamName: 'ThrottlingException' });
    const validation = new ValidationError('bad');
    await expect(
      guardPublic('op', async () => {
        await Promise.resolve();
        throw validation;
      }),
    ).rejects.toBe(validation);
  });
});

describe('guardPublicIterable', () => {
  it('yields every item and wraps a failure raised mid-iteration', async () => {
    /**
     * `guardPublicIterable`'s `source` parameter is typed `AsyncGenerator`;
     * this fake never actually suspends. `await Promise.resolve()` resolves
     * an already-resolved value — it costs one microtask and changes nothing
     * a caller can observe — and is what makes this a real async generator
     * rather than a sync one the type would reject.
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
      name: 'UpstreamError',
      upstreamName: 'ThrottlingException',
      context: { operation: 'saver.list' },
    });
    expect(seen).toEqual([1, 2]);
  });

  it('closes the source when the consumer stops early', async () => {
    let finished = false;
    /** Same reasoning as the `source` above: the parameter type is `AsyncGenerator`. */
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
