import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';

describe('JSON_SERDE', () => {
  it('round-trips a value through dumpsTyped/loadsTyped', async () => {
    const value = { a: 1, b: ['x', null], c: { d: true } };
    const [type, bytes] = await JSON_SERDE.dumpsTyped(value);
    expect(type).toBe('json');
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(await JSON_SERDE.loadsTyped(type, bytes)).toEqual(value);
  });

  it('loads from a string payload as well as bytes', async () => {
    expect(await JSON_SERDE.loadsTyped('json', JSON.stringify({ x: 5 }))).toEqual({ x: 5 });
  });
});
