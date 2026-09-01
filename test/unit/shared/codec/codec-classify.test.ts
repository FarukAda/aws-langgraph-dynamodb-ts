import { randomBytes } from 'node:crypto';

import {
  decodePayload,
  encodePayload,
  isMissingObjectError,
  isPermanentPayloadLoss,
  PayloadLocation,
  readPayloadBytes,
} from '../../../../src/shared/codec/codec';
import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { RetryExhaustedError, ValidationError } from '../../../../src/shared/errors/errors';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (_type: string, data: Uint8Array | string): Promise<unknown> =>
    JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)),
};

function s3Failure(causeName: string): DynamoDBLangGraphError {
  return new DynamoDBLangGraphError(
    's3 failed',
    ErrorCode.S3_OFFLOAD_FAILED,
    {},
    Object.assign(new Error(causeName), { name: causeName }),
  );
}

describe('readPayloadBytes', () => {
  it('returns the stored bytes of an inline descriptor without deserializing', async () => {
    const descriptor = await encodePayload({ a: 1 }, { serde }, { keyParts: ['k'] });
    const bytes = await readPayloadBytes(descriptor, { serde });
    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
  });

  it('downloads the bytes of an offloaded descriptor', async () => {
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[]) => parts.join('/'),
      upload: jest.fn(async (key: string) => key),
      download: jest.fn(async () => new TextEncoder().encode('{"b":2}')),
    };
    const deps = { serde, offloader: offloader as never };
    const descriptor = await encodePayload({ b: 2 }, deps, { keyParts: ['k'] });
    const bytes = await readPayloadBytes(descriptor, deps);
    expect(new TextDecoder().decode(bytes)).toBe('{"b":2}');
    expect(offloader.download).toHaveBeenCalledWith('k');
  });
});

describe('decodePayload without an offloader', () => {
  it('rejects an offloaded descriptor with a ValidationError naming the s3 option', async () => {
    const descriptor = {
      location: PayloadLocation.S3,
      serdeType: 'json',
      compressed: false,
      s3Key: 'somewhere',
    } as const;
    await expect(decodePayload(descriptor, { serde })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      message: expect.stringContaining('s3'),
    });
  });
});

describe('encodePayload inline size pre-flight (CKPT-03, CODEC-06, HIST-05)', () => {
  const big = { blob: 'x'.repeat(400 * 1024) };
  const nearlyBig = { blob: 'x'.repeat(380 * 1024) };

  it('rejects a payload that cannot fit a DynamoDB item when no offloader is configured', async () => {
    await expect(encodePayload(big, { serde }, { keyParts: ['k'] })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'payload' },
      message: expect.stringMatching(/s3/),
    });
  });

  it('offloads the same payload when an offloader is configured', async () => {
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[]) => parts.join('/'),
      upload: jest.fn(async (key: string) => key),
    };
    const descriptor = await encodePayload(
      big,
      { serde, offloader: offloader as never },
      {
        keyParts: ['k'],
      },
    );
    expect(descriptor.location).toBe(PayloadLocation.S3);
  });

  it('keeps a payload just under the cap inline', async () => {
    const descriptor = await encodePayload(nearlyBig, { serde }, { keyParts: ['k'] });
    expect(descriptor.location).toBe(PayloadLocation.INLINE);
  });

  it('suggests enabling compression when it is not on, and only s3 when it is', async () => {
    await expect(encodePayload(big, { serde }, { keyParts: ['k'] })).rejects.toMatchObject({
      message: expect.stringMatching(/compression/),
    });
    // ~683 KB of base64 over random bytes: gzip cannot bring it under the cap.
    const incompressible = { blob: randomBytes(512 * 1024).toString('base64') };
    await expect(
      encodePayload(incompressible, { serde, compression: { enabled: true } }, { keyParts: ['k'] }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      message: expect.not.stringMatching(/enable compression/),
    });
  });
});

describe('isMissingObjectError', () => {
  it('is true only for an S3 offload failure whose cause is NoSuchKey', () => {
    expect(isMissingObjectError(s3Failure('NoSuchKey'))).toBe(true);
    expect(isMissingObjectError(s3Failure('AccessDenied'))).toBe(false);
    expect(isMissingObjectError(new RetryExhaustedError('x', 5))).toBe(false);
    expect(isMissingObjectError(Object.assign(new Error('x'), { name: 'NoSuchKey' }))).toBe(false);
  });
});

describe('isPermanentPayloadLoss', () => {
  it('is true for a decompression-guard trip and a missing object, false otherwise', () => {
    const bomb = new DynamoDBLangGraphError('bomb', ErrorCode.COMPRESSION_LIMIT);
    expect(isPermanentPayloadLoss(bomb)).toBe(true);
    expect(isPermanentPayloadLoss(s3Failure('NoSuchKey'))).toBe(true);
    expect(isPermanentPayloadLoss(s3Failure('ServiceUnavailable'))).toBe(false);
    expect(isPermanentPayloadLoss(new ValidationError('v'))).toBe(false);
    expect(isPermanentPayloadLoss(new Error('plain'))).toBe(false);
  });
});
