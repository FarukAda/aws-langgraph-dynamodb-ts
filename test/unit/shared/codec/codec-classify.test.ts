import { randomBytes } from 'node:crypto';

import {
  decodePayload,
  PayloadLocation,
  readPayloadBytes,
  encodePayload,
  isMissingObjectError,
  isPermanentPayloadLoss,
  isRefusedObjectError,
} from '../../../../src/shared/codec/codec';
import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { retryExhaustedError, validationError } from '../../../../src/shared/errors/errors';

const serde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_type: string, data: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))),
};

function s3Failure(causeName: string): DynamoDBLangGraphError {
  return new DynamoDBLangGraphError(
    's3 failed',
    ErrorCode.S3_OFFLOAD_FAILED,
    {},
    Object.assign(new Error(causeName), { name: causeName }),
  );
}

/**
 * A row holds whatever its writer stored. Reading `.schemaVersion` off a
 * descriptor that is not an object raised a raw `TypeError` with no code, out
 * of a public method that promises a typed error.
 */
describe('a descriptor that is not an object', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'INLINE'],
    ['a number', 7],
  ])('is refused as a descriptor when it is %s', async (_name, descriptor) => {
    await expect(
      readPayloadBytes(descriptor as never, { serde: {} as never }, []),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'descriptor' } });
  });
});

describe('readPayloadBytes', () => {
  it('returns the stored bytes of an inline descriptor without deserializing', async () => {
    const descriptor = await encodePayload(
      { a: 1 },
      { serde },
      { keyParts: ['k'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
    );
    const bytes = await readPayloadBytes(descriptor, { serde }, []);
    expect(new TextDecoder().decode(bytes)).toBe('{"a":1}');
  });

  it('downloads the bytes of an offloaded descriptor', async () => {
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
      upload: jest.fn((key: string) => key),
      download: jest.fn(() => new TextEncoder().encode('{"b":2}')),
      assertOwnedKey: () => undefined,
    };
    const deps = { serde, offloader: offloader as never };
    const descriptor = await encodePayload({ b: 2 }, deps, {
      keyParts: ['k'],
      objectId: 'ID',
      row: { pk: 'PK', sk: 'SK' },
    });
    const bytes = await readPayloadBytes(descriptor, deps, []);
    expect(new TextDecoder().decode(bytes)).toBe('{"b":2}');
    expect(offloader.download).toHaveBeenCalledWith(
      (descriptor as { s3Key: string }).s3Key,
      undefined,
    );
  });

  /**
   * The codec is the only thing between a public method and an S3 request, so
   * the deps object is where a cancel has to arrive. An inline payload sends
   * nothing and reads the field not at all.
   */
  it('carries the deps signal into the upload and the download', async () => {
    const controller = new AbortController();
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
      upload: jest.fn((key: string) => key),
      download: jest.fn(() => new TextEncoder().encode('{"c":3}')),
      assertOwnedKey: () => undefined,
    };
    const deps = { serde, offloader: offloader as never, signal: controller.signal };
    const descriptor = await encodePayload({ c: 3 }, deps, {
      keyParts: ['k'],
      objectId: 'ID',
      row: { pk: 'PK', sk: 'SK' },
    });
    await readPayloadBytes(descriptor, deps, []);
    expect(offloader.upload).toHaveBeenCalledWith(
      'k/ID',
      expect.any(Uint8Array),
      { pk: 'PK', sk: 'SK' },
      controller.signal,
    );
    expect(offloader.download).toHaveBeenCalledWith('k/ID', controller.signal);
  });
});

describe('decodePayload without an offloader', () => {
  it('rejects an offloaded descriptor with a VALIDATION error naming the s3 option', async () => {
    const descriptor = {
      location: PayloadLocation.S3,
      serdeType: 'json',
      compressed: false,
      s3Key: 'somewhere',
    } as const;
    await expect(decodePayload(descriptor, { serde }, [])).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      message: expect.stringContaining('s3'),
    });
  });
});

describe('encodePayload inline size pre-flight', () => {
  const big = { blob: 'x'.repeat(400 * 1024) };
  const nearlyBig = { blob: 'x'.repeat(380 * 1024) };

  it('rejects a payload that cannot fit a DynamoDB item when no offloader is configured', async () => {
    await expect(
      encodePayload(
        big,
        { serde },
        { keyParts: ['k'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'payload' },
      message: expect.stringMatching(/s3/),
    });
  });

  it('offloads the same payload when an offloader is configured', async () => {
    const offloader = {
      shouldOffload: () => true,
      buildKey: (parts: readonly string[], objectId: string) => [...parts, objectId].join('/'),
      upload: jest.fn((key: string) => key),
    };
    const descriptor = await encodePayload(
      big,
      { serde, offloader: offloader as never },
      {
        keyParts: ['k'],
        objectId: 'ID',
        row: { pk: 'PK', sk: 'SK' },
      },
    );
    expect(descriptor.location).toBe(PayloadLocation.S3);
  });

  it('keeps a payload just under the cap inline', async () => {
    const descriptor = await encodePayload(
      nearlyBig,
      { serde },
      { keyParts: ['k'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
    );
    expect(descriptor.location).toBe(PayloadLocation.INLINE);
  });

  it('suggests enabling compression when it is not on, and only s3 when it is', async () => {
    await expect(
      encodePayload(
        big,
        { serde },
        { keyParts: ['k'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
      ),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/compression/),
    });
    // ~683 KB of base64 over random bytes: gzip cannot bring it under the cap.
    const incompressible = { blob: randomBytes(512 * 1024).toString('base64') };
    await expect(
      encodePayload(
        incompressible,
        { serde, compression: { enabled: true } },
        { keyParts: ['k'], objectId: 'ID', row: { pk: 'PK', sk: 'SK' } },
      ),
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
    expect(isMissingObjectError(retryExhaustedError('x', 5))).toBe(false);
    expect(isMissingObjectError(Object.assign(new Error('x'), { name: 'NoSuchKey' }))).toBe(false);
  });
});

describe('isRefusedObjectError', () => {
  it('is true only for a download S3 refused', () => {
    expect(isRefusedObjectError(s3Failure('AccessDenied'))).toBe(true);
    expect(isRefusedObjectError(s3Failure('NoSuchKey'))).toBe(false);
    expect(isRefusedObjectError(Object.assign(new Error('x'), { name: 'AccessDenied' }))).toBe(
      false,
    );
  });
});

describe('isPermanentPayloadLoss', () => {
  it('is true for a missing object, and false for a decompression limit and everything else', () => {
    const bomb = new DynamoDBLangGraphError('bomb', ErrorCode.COMPRESSION_LIMIT);
    expect(isPermanentPayloadLoss(bomb)).toBe(false);
    expect(isPermanentPayloadLoss(s3Failure('NoSuchKey'))).toBe(true);
    expect(isPermanentPayloadLoss(s3Failure('ServiceUnavailable'))).toBe(false);
    expect(isPermanentPayloadLoss(validationError('v'))).toBe(false);
    expect(isPermanentPayloadLoss(new Error('plain'))).toBe(false);
  });
});

describe('isPermanentPayloadLoss on descriptor rejections', () => {
  it('treats an unreadable descriptor as permanent and other validation, s3Key included, as not', () => {
    expect(isPermanentPayloadLoss(validationError('not a descriptor', 'descriptor'))).toBe(true);
    expect(isPermanentPayloadLoss(validationError('bad option', 's3'))).toBe(false);
  });

  /**
   * The one descriptor refusal that is not the payload's own fault. A newer
   * release wrote it and reads it, so it carries the format code rather than
   * the descriptor validation, and no policy may drop it.
   */
  it('does not treat a payload a newer release wrote as payload loss', () => {
    const forward = new DynamoDBLangGraphError('newer', ErrorCode.FORMAT_UNSUPPORTED, {
      field: 'schemaVersion',
    });
    expect(isPermanentPayloadLoss(forward)).toBe(false);
  });

  /**
   * An out-of-scope key means the reader may not follow it — a wrong prefix or
   * a foreign row — not that the payload is unreadable, so it is reported
   * rather than skipped.
   */
  it('does not treat an out-of-scope key as payload loss', () => {
    expect(isPermanentPayloadLoss(validationError('foreign', 's3Key'))).toBe(false);
  });
});
