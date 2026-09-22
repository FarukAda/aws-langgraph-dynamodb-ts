import { decodePayload, PayloadLocation } from '../../../../src/shared/codec/codec';
import { encodePayload } from '../../../../src/shared/codec/encode';
import { buildS3Key } from '../../../../src/shared/codec/s3/config';
import { assertKeyInScope } from '../../../../src/shared/codec/s3/key-scope';
import { MAX_LOGGED_VALUE_CHARS } from '../../../../src/shared/constants';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { truncateForLog } from '../../../../src/shared/logging/truncate';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (_type: string, data: Uint8Array | string): Promise<unknown> =>
    JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)),
};

describe('encodePayload / decodePayload', () => {
  it('round-trips an inline payload', async () => {
    const descriptor = await encodePayload(
      { a: 1 },
      { serde },
      { keyParts: ['t', 'c', 'f'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
    );
    expect(descriptor.location).toBe(PayloadLocation.INLINE);
    expect(descriptor.serdeType).toBe('json');
    expect(descriptor.compressed).toBe(false);
    expect(await decodePayload(descriptor, { serde }, [])).toEqual({ a: 1 });
  });

  it('round-trips an inline payload whose serialized bytes start with 0x4C 0x47 0x43', async () => {
    const lgcSerde = {
      dumpsTyped: async (): Promise<[string, Uint8Array]> => [
        'raw',
        new Uint8Array([0x4c, 0x47, 0x43, 1, 2, 3]),
      ],
      loadsTyped: async (_type: string, data: Uint8Array | string): Promise<unknown> =>
        Array.from(typeof data === 'string' ? new TextEncoder().encode(data) : data),
    };
    const descriptor = await encodePayload(
      'ignored',
      { serde: lgcSerde },
      { keyParts: ['t'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
    );
    expect(descriptor.compressed).toBe(false);
    expect(await decodePayload(descriptor, { serde: lgcSerde }, [])).toEqual([
      0x4c, 0x47, 0x43, 1, 2, 3,
    ]);
  });

  it('offloads to S3 when the encoded payload exceeds the threshold', async () => {
    let stored: Uint8Array = new Uint8Array();
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[], objectId: string) =>
        `pfx/${[...parts, objectId].join('/')}.bin`,
      upload: jest.fn(async (key: string, data: Uint8Array) => {
        stored = data;
        return key;
      }),
      download: jest.fn(async () => stored),
      assertOwnedKey: () => undefined,
    };
    const descriptor = await encodePayload(
      { a: 1 },
      { serde, offloader: offloader as never },
      { keyParts: ['t', 'c', 'f'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
    );
    expect(descriptor.location).toBe(PayloadLocation.S3);
    if (descriptor.location === PayloadLocation.S3) {
      expect(descriptor.s3Key).toBe('pfx/t/c/f/ID.bin');
    }
    expect(offloader.upload).toHaveBeenCalled();
    expect(await decodePayload(descriptor, { serde, offloader: offloader as never }, [])).toEqual({
      a: 1,
    });
  });

  /**
   * The key names the write, not the bytes: two writes of one value for one
   * row get two objects, and one write's key is the same however its bytes
   * compare with another's.
   */
  it('keys an offloaded payload by the object id it is given, never by its bytes', async () => {
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[], objectId: string) => buildS3Key('p/', parts, objectId),
      upload: jest.fn(async (key: string) => key),
    };
    const deps = { serde, offloader: offloader as never };
    const keyOf = async (value: object, objectId: string) =>
      (
        (await encodePayload(value, deps, {
          keyParts: ['row'],
          objectId,
          row: { pk: 'PK', sk: 'SK' },
        })) as { s3Key: string }
      ).s3Key;

    expect(await keyOf({ a: 1 }, '01J0000000000000000000000A')).toBe(
      'p/cm93/01J0000000000000000000000A.bin',
    );
    expect(await keyOf({ a: 1 }, '01J0000000000000000000000B')).toBe(
      'p/cm93/01J0000000000000000000000B.bin',
    );
    expect(await keyOf({ b: 2 }, '01J0000000000000000000000A')).toBe(
      'p/cm93/01J0000000000000000000000A.bin',
    );
  });

  it('stores inline when an offloader is present but the payload is below threshold', async () => {
    const offloader = {
      shouldOffload: () => false,
      buildKey: () => 'unused',
      upload: jest.fn(),
      download: jest.fn(),
    };
    const descriptor = await encodePayload(
      { a: 1 },
      { serde, offloader: offloader as never },
      { keyParts: ['t'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
    );
    expect(descriptor.location).toBe(PayloadLocation.INLINE);
    expect(offloader.upload).not.toHaveBeenCalled();
  });

  it('compresses when compression is enabled and round-trips it', async () => {
    const big = { text: 'A'.repeat(4096) };
    const descriptor = await encodePayload(
      big,
      { serde, compression: { enabled: true } },
      { keyParts: ['t'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
    );
    expect(descriptor.location).toBe(PayloadLocation.INLINE);
    expect(descriptor.compressed).toBe(true);
    expect(await decodePayload(descriptor, { serde, compression: { enabled: true } }, [])).toEqual(
      big,
    );
  });

  it('throws when asked to decode an S3 payload without an offloader', async () => {
    const descriptor = {
      location: PayloadLocation.S3 as const,
      serdeType: 'json',
      compressed: false,
      s3Key: 'k',
    };
    await expect(decodePayload(descriptor, { serde }, [])).rejects.toMatchObject({
      name: 'ValidationError',
      message: expect.stringContaining('no `s3` configuration'),
    });
  });
});

describe('row-sourced key binding (SEC-03)', () => {
  const scoped = (prefix: string) => ({
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => buildS3Key(prefix, parts, objectId),
    upload: jest.fn(async (key: string) => key),
    download: jest.fn(async () => new TextEncoder().encode('{"a":1}')),
    assertOwnedKey: (key: string, scope: readonly string[]) => assertKeyInScope(key, prefix, scope),
  });

  it("refuses to download a descriptor whose key lies outside the row's own path", async () => {
    const offloader = scoped('p/');
    const descriptor = {
      location: PayloadLocation.S3,
      serdeType: 'json',
      compressed: false,
      s3Key: buildS3Key('p/', ['other-thread', 'c'], 'ID'),
    } as const;
    await expect(
      decodePayload(descriptor, { serde, offloader: offloader as never }, ['my-thread']),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 's3Key' } });
    expect(offloader.download).not.toHaveBeenCalled();
  });

  it("downloads a descriptor whose key lies under the row's own path", async () => {
    const offloader = scoped('p/');
    const deps = { serde, offloader: offloader as never };
    const descriptor = await encodePayload({ a: 1 }, deps, {
      keyParts: ['my-thread', 'c', 'n'],
      objectId: 'ID',
      row: { pk: 'PK', sk: 'SK' },
    });
    await expect(decodePayload(descriptor, deps, ['my-thread'])).resolves.toEqual({ a: 1 });
    expect(offloader.download).toHaveBeenCalledTimes(1);
  });
});

describe('persisted descriptor shape (CODEC-16)', () => {
  it('stamps every descriptor with schemaVersion 1', async () => {
    const descriptor = await encodePayload(
      { a: 1 },
      { serde },
      { keyParts: ['k'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
    );
    expect(descriptor.schemaVersion).toBe(1);
  });

  /**
   * The id names the write, not the row, and it is the identity a later delete
   * pins on to tell the row it observed from one another write replaced it
   * with. A payload's size decides which descriptor kind a row gets and nothing
   * about that identity changes with it, so both kinds have to carry it.
   */
  it('stamps the write id it was given on an inline and on an offloaded descriptor', async () => {
    const options = { keyParts: ['k'], objectId: 'WRITE-1', row: { pk: 'PK', sk: 'SK' } };
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
      upload: async (key: string) => key,
    };
    const inline = await encodePayload({ a: 1 }, { serde }, options);
    const offloaded = await encodePayload(
      { a: 1 },
      { serde, offloader: offloader as never },
      options,
    );
    expect(inline.location).toBe(PayloadLocation.INLINE);
    expect(offloaded.location).toBe(PayloadLocation.S3);
    expect(inline.writeId).toBe('WRITE-1');
    expect(offloaded.writeId).toBe('WRITE-1');
  });

  it('reads a descriptor written before the version field existed', async () => {
    const legacy = {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new TextEncoder().encode('{"a":1}'),
    } as const;
    await expect(decodePayload(legacy, { serde }, [])).resolves.toEqual({ a: 1 });
  });

  /**
   * The code is `FORMAT_UNSUPPORTED`, not the `descriptor` validation this
   * once asserted: a forward `schemaVersion` says the payload is intact and the
   * release that wrote it reads it, which is the same thing a forward `v` on
   * the row around it says and is answered the same way. Under the old code it
   * fell into the permanent-loss bucket, where history's default `skip` dropped
   * it while the store and the saver refused the identical row — the one
   * descriptor refusal for which "no other reader would fare better" is false.
   */
  it('refuses a descriptor written by a newer schema version as an unsupported format', async () => {
    const future = {
      schemaVersion: 2,
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array(),
    } as const;
    await expect(decodePayload(future, { serde }, [])).rejects.toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'schemaVersion' },
      message: expect.stringContaining('upgrade'),
    });
  });

  /**
   * The version is whatever the row holds. It is declared a number, and the
   * comparison coerces, so a row carrying a thousand digits as a string passes
   * it and reaches the message — a row-sourced value in a public error.
   */
  it('bounds a row-sourced schemaVersion it quotes', async () => {
    const version = '9'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const future = {
      schemaVersion: version,
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array(),
    } as never;
    const refusal = await decodePayload(future, { serde }, []).then(
      () => new Error('should have thrown'),
      (error: Error) => error,
    );
    expect(refusal).toMatchObject({
      code: ErrorCode.FORMAT_UNSUPPORTED,
      context: { field: 'schemaVersion' },
    });
    expect(refusal.message).not.toContain(version);
    expect(refusal.message).toContain(truncateForLog(version));
  });

  it('refuses a descriptor with an unknown location without touching S3', async () => {
    const offloader = { download: jest.fn(), assertOwnedKey: jest.fn() };
    const odd = {
      location: 'TAPE',
      serdeType: 'json',
      compressed: false,
      s3Key: 'somewhere',
    } as never;
    await expect(
      decodePayload(odd, { serde, offloader: offloader as never }, []),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'descriptor' } });
    expect(offloader.download).not.toHaveBeenCalled();
  });

  /**
   * The location is whatever the row carries, so the message that quotes it is
   * as long as the row makes it. `context.field` is what a caller branches on
   * and does not move.
   */
  it('bounds the row-sourced location it quotes', async () => {
    const location = 'T'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const odd = { location, serdeType: 'json', compressed: false } as never;
    const refusal = await decodePayload(odd, { serde }, []).then(
      () => new Error('should have thrown'),
      (error: Error) => error,
    );
    expect(refusal).toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'descriptor' },
    });
    expect(refusal.message).not.toContain(location);
    expect(refusal.message).toContain(location.slice(0, MAX_LOGGED_VALUE_CHARS - 1));
    expect(refusal.message.length).toBeLessThan(location.length);
  });
});
