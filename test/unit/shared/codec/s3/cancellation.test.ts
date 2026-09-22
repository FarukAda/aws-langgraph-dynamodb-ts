/**
 * Cancellation on the S3 side, which had none at all: both wrappers called
 * `withRetry` with no signal, so an abort did not even cut a backoff wait.
 *
 * Two claims. The signal reaches the request as `abortSignal`, which is the
 * only bound a streaming body has once the response headers have arrived; and
 * a cancel is reported as a cancel, because both wrappers otherwise turn every
 * failure into `S3_OFFLOAD_FAILED` and would tell a caller who stopped a read
 * that its payload could not be offloaded.
 */
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { downloadObject, uploadObject } from '../../../../../src/shared/codec/s3/read-write';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';

const s3Mock = mockClient(S3Client);
const client = (): S3Client => new S3Client({ region: 'us-east-1' });
const MAX_BYTES = 1024;

afterEach(() => s3Mock.reset());

/** What the SDK rejects a request cut before its response with. */
const sdkAbort = (): Error => Object.assign(new Error('Request aborted'), { name: 'AbortError' });

/** What a body cut mid-stream rejects with once the socket is destroyed. */
const socketCut = (): Error => Object.assign(new Error('aborted'), { code: 'ECONNRESET' });

/**
 * The second argument of a recorded `send`, which is where the request options
 * ride. `aws-sdk-client-mock` types `args` as the one-tuple of the command
 * alone, so the options it faithfully records are unreachable without this.
 */
function requestOf(call: { args: unknown[] }): unknown {
  return call.args[1];
}

function bytesBody(chunks: Uint8Array[]): { transformToByteArray: () => Promise<Uint8Array> } {
  return {
    transformToByteArray: async () => chunks[0],
    [Symbol.asyncIterator]: async function* () {
      yield* chunks;
    },
  } as never;
}

describe('the signal reaches the S3 request', () => {
  it('is sent as abortSignal on the upload', async () => {
    const controller = new AbortController();
    s3Mock.on(PutObjectCommand).resolves({});
    await uploadObject(client(), {
      bucket: 'b',
      key: 'k.bin',
      data: new Uint8Array([1]),
      signal: controller.signal,
    });
    expect(requestOf(s3Mock.commandCalls(PutObjectCommand)[0])).toEqual({
      abortSignal: controller.signal,
    });
  });

  it('is sent as abortSignal on the download', async () => {
    const controller = new AbortController();
    s3Mock.on(GetObjectCommand).resolves({ Body: bytesBody([new Uint8Array([7])]) as never });
    await downloadObject(client(), 'b', 'k.bin', MAX_BYTES, controller.signal);
    expect(requestOf(s3Mock.commandCalls(GetObjectCommand)[0])).toEqual({
      abortSignal: controller.signal,
    });
  });

  it('is absent, not malformed, when the caller gave none', async () => {
    s3Mock.on(PutObjectCommand).resolves({});
    await uploadObject(client(), { bucket: 'b', key: 'k.bin', data: new Uint8Array([1]) });
    expect(requestOf(s3Mock.commandCalls(PutObjectCommand)[0])).toEqual({ abortSignal: undefined });
  });
});

describe('a cancelled transfer is reported as a cancel', () => {
  it('spends no request at all when the signal is already set', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadObject(client(), {
        bucket: 'b',
        key: 'k.bin',
        data: new Uint8Array([1]),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED, name: 'AbortError' });
    expect(s3Mock.commandCalls(PutObjectCommand)).toHaveLength(0);
  });

  it('answers an upload cut in flight with ABORTED rather than S3_OFFLOAD_FAILED', async () => {
    const controller = new AbortController();
    s3Mock.on(PutObjectCommand).callsFake(() => {
      controller.abort();
      throw sdkAbort();
    });
    await expect(
      uploadObject(client(), {
        bucket: 'b',
        key: 'k.bin',
        data: new Uint8Array([1]),
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED, name: 'AbortError' });
  });

  /**
   * The case a request timeout provably cannot cover. The handler resolved at
   * the headers, so what a cancel produces here is the stream's own socket
   * error — which every classifier in this package reads as transient, and
   * which would otherwise spend the whole budget and end as a typed offload
   * failure.
   */
  it('answers a download cut mid-body with ABORTED, and re-sends nothing', async () => {
    const controller = new AbortController();
    s3Mock.on(GetObjectCommand).resolves({
      Body: {
        transformToByteArray: async () => {
          controller.abort();
          throw socketCut();
        },
      } as never,
    });
    await expect(
      downloadObject(client(), 'b', 'k.bin', MAX_BYTES, controller.signal),
    ).rejects.toMatchObject({ code: ErrorCode.ABORTED, name: 'AbortError' });
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(1);
  });

  /** A failure with no signal set is still wrapped exactly as it was. */
  it('still wraps an ordinary failure as S3_OFFLOAD_FAILED', async () => {
    const controller = new AbortController();
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('nope'), { name: 'NoSuchKey' }));
    await expect(
      downloadObject(client(), 'b', 'k.bin', MAX_BYTES, controller.signal),
    ).rejects.toMatchObject({ code: ErrorCode.S3_OFFLOAD_FAILED });
  });
});
