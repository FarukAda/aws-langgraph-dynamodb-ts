import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, type TranslateConfig } from '@aws-sdk/lib-dynamodb';

import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import {
  ABORT_SIGNAL_MEMBERS,
  assertBaseCollaborators,
  assertClientTranslation,
  assertMembers,
  assertSignalLike,
  CLIENT_MEMBERS,
  EMBEDDINGS_MEMBERS,
  isAbortSignalLike,
  LOGGER_MEMBERS,
  SERDE_MEMBERS,
  VECTOR_BACKEND_MEMBERS,
} from '../../../../src/shared/validation/collaborators';

describe('assertMembers', () => {
  it('accepts a value exposing every named member as a function', () => {
    expect(() => assertMembers({ a: () => {}, b: () => {} }, ['a', 'b'], 'thing')).not.toThrow();
  });

  it('refuses a non-object value, naming the field alone', () => {
    for (const value of ['x', 7, true]) {
      try {
        assertMembers(value as never, ['a'], 'thing');
        throw new Error('should have thrown');
      } catch (error) {
        const typed = error as { code: ErrorCode; context: { field?: string } };
        expect(typed.code).toBe(ErrorCode.VALIDATION);
        expect(typed.context.field).toBe('thing');
      }
    }
  });

  it('refuses null, naming the field alone', () => {
    expect(() => assertMembers(null as never, ['a'], 'thing')).toThrow(
      expect.objectContaining({ context: { field: 'thing' } }),
    );
  });

  /** An array is no collaborator: it was reported as missing its first member (`thing.a`). */
  it('refuses an array, naming the field alone', () => {
    expect(() => assertMembers([] as never, ['a'], 'thing')).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'thing' } }),
    );
  });

  it('names the first missing member, dotted under the field', () => {
    expect(() => assertMembers({ a: () => {} }, ['a', 'b'], 'thing')).toThrow(
      expect.objectContaining({ context: { field: 'thing.b' } }),
    );
  });

  it('refuses a member that is present but not callable, same as one absent', () => {
    expect(() => assertMembers({ a: 1 }, ['a'], 'thing')).toThrow(
      expect.objectContaining({ context: { field: 'thing.a' } }),
    );
  });
});

describe('assertBaseCollaborators', () => {
  it('leaves every collaborator unchecked when none was supplied', () => {
    expect(() => assertBaseCollaborators({})).not.toThrow();
  });

  it('checks an injected client only when one was supplied', () => {
    const complete = {
      get() {},
      put() {},
      delete() {},
      update() {},
      query() {},
      scan() {},
      batchWrite() {},
      transactWrite() {},
    };
    expect(() => assertBaseCollaborators({ client: complete })).not.toThrow();
    expect(() => assertBaseCollaborators({ client: {} })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'client.get' } }),
    );
  });

  it('checks an injected logger only when one was supplied', () => {
    const complete = { debug() {}, info() {}, warn() {}, error() {} };
    expect(() => assertBaseCollaborators({ logger: complete })).not.toThrow();
    expect(() => assertBaseCollaborators({ logger: {} })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'logger.debug' } }),
    );
  });

  it('checks an injected serde only when one was supplied', () => {
    const complete = { dumpsTyped() {}, loadsTyped() {} };
    expect(() => assertBaseCollaborators({ serde: complete })).not.toThrow();
    expect(() => assertBaseCollaborators({ serde: {} })).toThrow(
      expect.objectContaining({ code: 'VALIDATION', context: { field: 'serde.dumpsTyped' } }),
    );
  });
});

describe('the member lists, verified against the call sites in src/', () => {
  it('lists exactly what each collaborator is called with', () => {
    expect(CLIENT_MEMBERS).toEqual([
      'get',
      'put',
      'delete',
      'update',
      'query',
      'scan',
      'batchWrite',
      'transactWrite',
    ]);
    expect(LOGGER_MEMBERS).toEqual(['debug', 'info', 'warn', 'error']);
    expect(SERDE_MEMBERS).toEqual(['dumpsTyped', 'loadsTyped']);
    expect(EMBEDDINGS_MEMBERS).toEqual(['embedQuery', 'embedDocuments']);
  });

  /** `listKeys` is optional on the interface and reconcile already handles its absence, so it must not be required. */
  it('does not require vectorBackend.listKeys', () => {
    expect(VECTOR_BACKEND_MEMBERS).toEqual(['upsert', 'query', 'delete']);
  });
});

describe('isAbortSignalLike', () => {
  it('is false for a non-object value, including undefined', () => {
    expect(isAbortSignalLike(undefined)).toBe(false);
    expect(isAbortSignalLike('x' as never)).toBe(false);
  });

  it('is false for null', () => {
    expect(isAbortSignalLike(null as never)).toBe(false);
  });

  it('is false when aborted is not a boolean', () => {
    expect(isAbortSignalLike({ aborted: 'no', addEventListener: () => {} } as never)).toBe(false);
  });

  it('is false when addEventListener is not callable', () => {
    expect(isAbortSignalLike({ aborted: false, addEventListener: 1 } as never)).toBe(false);
  });

  /** The wait between retries removes its listener; a signal that cannot is not usable. */
  it('is false when removeEventListener is missing or not callable', () => {
    const add = () => {};
    expect(isAbortSignalLike({ aborted: false, addEventListener: add } as never)).toBe(false);
    expect(
      isAbortSignalLike({ aborted: false, addEventListener: add, removeEventListener: 1 } as never),
    ).toBe(false);
  });

  it('is true for a real AbortSignal, and for a structurally equivalent double', () => {
    expect(isAbortSignalLike(new AbortController().signal)).toBe(true);
    const double = { aborted: false, addEventListener: () => {}, removeEventListener: () => {} };
    expect(isAbortSignalLike(double as never)).toBe(true);
  });

  /** Every member the package touches on a signal, checked against `retry.ts`. */
  it('checks exactly the members this package uses, by the type each must have', () => {
    expect(ABORT_SIGNAL_MEMBERS).toEqual({
      aborted: 'boolean',
      addEventListener: 'function',
      removeEventListener: 'function',
    });
  });
});

describe('assertSignalLike', () => {
  it('leaves an absent signal unchecked', () => {
    expect(() => assertSignalLike(undefined)).not.toThrow();
  });

  it('accepts a real AbortSignal', () => {
    expect(() => assertSignalLike(new AbortController().signal)).not.toThrow();
  });

  it('refuses a value that is not AbortSignal-like, naming `signal`', () => {
    expect(() => assertSignalLike({} as never)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'signal' } }),
    );
  });
});

const documentWith = (translateConfig?: TranslateConfig) =>
  DynamoDBDocument.from(new DynamoDBClient({ region: 'us-east-1' }), translateConfig);

function refusal(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('assertClientTranslation', () => {
  it('accepts a client built with the default translation, and a hand-rolled double', () => {
    expect(refusal(() => assertClientTranslation(documentWith()))).toBeUndefined();
    expect(refusal(() => assertClientTranslation({ get: () => undefined }))).toBeUndefined();
  });

  it('accepts the options this package does not depend on', () => {
    const client = documentWith({
      marshallOptions: { removeUndefinedValues: true, convertClassInstanceToMap: true },
      unmarshallOptions: { wrapNumbers: false },
    });
    expect(refusal(() => assertClientTranslation(client))).toBeUndefined();
  });

  it.each([
    ['wraps numbers', documentWith({ unmarshallOptions: { wrapNumbers: true } })],
    [
      'wraps numbers through a function',
      documentWith({ unmarshallOptions: { wrapNumbers: (value: string) => Number(value) } }),
    ],
    [
      'stores an empty value as NULL',
      documentWith({ marshallOptions: { convertEmptyValues: true } }),
    ],
  ])('refuses a client that %s, naming client', (_label, client) => {
    expect(refusal(() => assertClientTranslation(client))).toMatchObject({
      code: 'VALIDATION',
      context: { field: 'client' },
    });
  });

  it('is what an adapter checks its injected client with', () => {
    const client = documentWith({ unmarshallOptions: { wrapNumbers: true } });
    expect(refusal(() => new DynamoDBSaver({ tableName: 'tbl', client }))).toMatchObject({
      context: { field: 'client' },
    });
  });
});
