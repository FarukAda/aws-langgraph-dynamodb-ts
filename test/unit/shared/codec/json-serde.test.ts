import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { isPermanentPayloadLoss } from '../../../../src/shared/codec/payload-loss';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { DynamoDBStore } from '../../../../src/store/store';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

describe('JSON_SERDE.dumpsTyped', () => {
  it('round-trips a value through dumpsTyped/loadsTyped', async () => {
    const value = { a: 1, b: ['x', null], c: { d: true } };
    const [type, bytes] = await JSON_SERDE.dumpsTyped(value);
    expect(type).toBe('json');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(await JSON_SERDE.loadsTyped(type, bytes)).toEqual(value);
  });

  it('stores null, which JSON does represent', async () => {
    const [, bytes] = await JSON_SERDE.dumpsTyped(null);
    expect(await JSON_SERDE.loadsTyped('json', bytes)).toBeNull();
  });

  /**
   * These stringify to `undefined`, which encodes to **zero bytes**: the write
   * succeeded and every later read of that row failed to parse. Refusing at
   * the write is what keeps an unreadable row from being created.
   */
  it.each([
    ['undefined', undefined],
    ['a function', () => 1],
    ['a symbol', Symbol('s')],
  ])('refuses %s, which has no JSON representation', async (_name, value) => {
    await expect(JSON_SERDE.dumpsTyped(value)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'value' },
    });
  });

  it.each([
    [
      'a circular structure',
      (): unknown => {
        const node: Record<string, unknown> = {};
        node.self = node;
        return node;
      },
    ],
    ['a BigInt', (): unknown => 1n],
    /**
     * `JSON.stringify` calls `toJSON`, so whatever that method throws is what
     * this `catch` binds — and `throw 'boom'` is legal JavaScript. A caught
     * value that is not an `Error` used to leave the redacting call this clause
     * makes with a bare `TypeError`, out of the one serializer two of the three
     * adapters use by default.
     */
    [
      'a toJSON that throws a string',
      (): unknown => ({
        toJSON: (): never => {
          throw 'boom';
        },
      }),
    ],
  ])('reports %s as a validation failure rather than a raw TypeError', async (_name, build) => {
    await expect(JSON_SERDE.dumpsTyped(build())).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'value' },
    });
  });

  /**
   * V8 writes the path it walked into the message it throws for a circular
   * structure, quoting the caller's own property names and constructor names.
   * Interpolating that put them on `err.message` of a public error, which an
   * application may print, log or return in a response — and this package
   * treats a caller's identifiers as structured data, never as text to compose
   * a message out of. `redactedMessage` removes credential *shapes*, not
   * names, so it never covered this. The refusal is kept as `cause`, where a
   * caller who wants the path can still read it.
   */
  it('never quotes a property or class name off the value it refused', async () => {
    class PatientRecord {
      readonly socialSecurityNumberRef: Record<string, unknown> = {};
    }
    const node = new PatientRecord();
    node.socialSecurityNumberRef.backToPatient = node;
    const error = await JSON_SERDE.dumpsTyped(node).catch((e: Error) => e);
    expect((error as Error).message).not.toMatch(/socialSecurityNumberRef|backToPatient|Patient/);
    expect((error as Error).cause).toMatchObject({ name: 'TypeError' });
  });
});

describe('JSON_SERDE.loadsTyped', () => {
  it('loads from a string payload as well as bytes', async () => {
    expect(await JSON_SERDE.loadsTyped('json', JSON.stringify({ x: 5 }))).toEqual({ x: 5 });
  });

  it.each([
    ['empty bytes', new Uint8Array()],
    ['bytes that are not JSON', new TextEncoder().encode('{oops')],
  ])('reports %s as PAYLOAD_CORRUPT', async (_name, data) => {
    await expect(JSON_SERDE.loadsTyped('json', data)).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_CORRUPT,
    });
  });

  it('reports an unparseable payload as permanent', async () => {
    const error = await JSON_SERDE.loadsTyped('json', new Uint8Array()).catch((e: Error) => e);
    expect(isPermanentPayloadLoss(error as Error)).toBe(true);
  });

  /**
   * The codec only ever hands it a `Uint8Array`, but the serializer is
   * exported, so a caller can hand it anything. `TextDecoder` answered such a
   * value with a bare `TypeError` naming an argument called "list" — the one
   * error shape no public entry point in this package is allowed to produce.
   * It is a validation failure and not a corrupt row: UTF-8 decoding replaces
   * a malformed byte rather than refusing it, so the only way the decode fails
   * is a `data` that is not bytes.
   */
  it.each([
    ['null', null],
    ['a plain object', {}],
    ['a number', 42],
  ])('refuses %s as data, naming the argument', async (_name, data) => {
    await expect(
      JSON_SERDE.loadsTyped('json', data as unknown as Uint8Array),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'data' } });
  });
});

/**
 * `JSON_SERDE` is the default of `DynamoDBStore` and
 * `DynamoDBChatMessageHistory`, so a refusal it cannot brand is a refusal the
 * adapter cannot brand either — and the surface tier's invariant is that every
 * public entry point answers a caller's mistake with a branded error.
 */
describe('the default serde as an adapter reaches it', () => {
  it('lets store.put refuse a toJSON that throws a string, branded', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    const store = new DynamoDBStore({ tableName: 'store', client });
    const value = {
      toJSON: (): never => {
        throw 'boom';
      },
    };
    await expect(store.put(['ns'], 'k', value)).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'value' },
    });
  });
});

/**
 * One object serves every adapter in the process that passed no `serde`, and
 * it is reachable from the package root, so an assignment to either method by
 * any one consumer would change how every other one reads and writes — the
 * same argument that freezes `ErrorCode`.
 */
describe('JSON_SERDE as a shared object', () => {
  it('refuses a method swap', () => {
    expect(Object.isFrozen(JSON_SERDE)).toBe(true);
    expect(() => {
      (JSON_SERDE as { dumpsTyped: unknown }).dumpsTyped = (): void => undefined;
    }).toThrow(TypeError);
  });
});
