import { decodePayload, PayloadLocation } from '../../../../src/shared/codec/codec';
import { encodePayload } from '../../../../src/shared/codec/encode';
import { buildS3Key } from '../../../../src/shared/codec/s3/config';
import { assertKeyInScope } from '../../../../src/shared/codec/s3/key-scope';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

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
    const descriptor = await encodePayload({ a: 1 }, { serde }, { keyParts: ['t', 'c', 'f'] });
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
    const descriptor = await encodePayload('ignored', { serde: lgcSerde }, { keyParts: ['t'] });
    expect(descriptor.compressed).toBe(false);
    expect(await decodePayload(descriptor, { serde: lgcSerde }, [])).toEqual([
      0x4c, 0x47, 0x43, 1, 2, 3,
    ]);
  });

  it('offloads to S3 when the encoded payload exceeds the threshold', async () => {
    let stored: Uint8Array = new Uint8Array();
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[]) => `pfx/${parts.join('/')}.bin`,
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
      { keyParts: ['t', 'c', 'f'] },
    );
    expect(descriptor.location).toBe(PayloadLocation.S3);
    if (descriptor.location === PayloadLocation.S3) {
      expect(descriptor.s3Key).toBe('pfx/t/c/f.bin');
    }
    expect(offloader.upload).toHaveBeenCalled();
    expect(await decodePayload(descriptor, { serde, offloader: offloader as never }, [])).toEqual({
      a: 1,
    });
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
      { keyParts: ['t'] },
    );
    expect(descriptor.location).toBe(PayloadLocation.INLINE);
    expect(offloader.upload).not.toHaveBeenCalled();
  });

  it('compresses when compression is enabled and round-trips it', async () => {
    const big = { text: 'A'.repeat(4096) };
    const descriptor = await encodePayload(
      big,
      { serde, compression: { enabled: true } },
      { keyParts: ['t'] },
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
    buildKey: (parts: readonly string[]) => buildS3Key(prefix, parts),
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
      s3Key: buildS3Key('p/', ['other-thread', 'c']),
    } as const;
    await expect(
      decodePayload(descriptor, { serde, offloader: offloader as never }, ['my-thread']),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 's3Key' } });
    expect(offloader.download).not.toHaveBeenCalled();
  });

  it("downloads a descriptor whose key lies under the row's own path", async () => {
    const offloader = scoped('p/');
    const deps = { serde, offloader: offloader as never };
    const descriptor = await encodePayload({ a: 1 }, deps, { keyParts: ['my-thread', 'c', 'n'] });
    await expect(decodePayload(descriptor, deps, ['my-thread'])).resolves.toEqual({ a: 1 });
    expect(offloader.download).toHaveBeenCalledTimes(1);
  });
});

describe('persisted descriptor shape (CODEC-16)', () => {
  it('stamps every descriptor with schemaVersion 1', async () => {
    const descriptor = await encodePayload({ a: 1 }, { serde }, { keyParts: ['k'] });
    expect(descriptor.schemaVersion).toBe(1);
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

  it('refuses a descriptor written by a newer schema version', async () => {
    const future = {
      schemaVersion: 2,
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new Uint8Array(),
    } as const;
    await expect(decodePayload(future, { serde }, [])).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'descriptor' },
      message: expect.stringContaining('newer'),
    });
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
});
