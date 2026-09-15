import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { isPermanentPayloadLoss } from '../../../../src/shared/codec/payload-loss';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

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
  ])('reports %s as a validation failure rather than a raw TypeError', async (_name, build) => {
    await expect(JSON_SERDE.dumpsTyped(build())).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'value' },
    });
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
});
