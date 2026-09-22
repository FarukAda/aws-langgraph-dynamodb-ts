import type { S3Client } from '@aws-sdk/client-s3';

import { S3Offloader } from '../../../../../src/shared/codec/s3/offloader';
import { downloadObject } from '../../../../../src/shared/codec/s3/read-write';
import { DEFAULT_SOCKET_TIMEOUT_MS } from '../../../../../src/shared/constants';

type ClientModule = typeof import('../../../../../src/shared/codec/s3/client');

/** The `requestHandler` options object a call site handed the SDK. */
type HandlerOptions = Record<string, number | boolean>;

/** An S3 client config as this library hands it over, before the SDK resolves it. */
interface BuiltConfig {
  maxAttempts?: number;
  region?: string;
  requestHandler?: HandlerOptions;
}

const built: BuiltConfig[] = [];

/**
 * A fresh copy of the client module whose `@aws-sdk/client-s3` yields an
 * `S3Client` that only records the config it was constructed with. A real
 * client resolves `requestHandler` into a handler instance while it is being
 * constructed, so the object this library actually hands over is observable
 * only here.
 */
function capturingClientModule(): ClientModule {
  let loaded: ClientModule | undefined;
  jest.isolateModules(() => {
    jest.doMock('@aws-sdk/client-s3', () => ({
      S3Client: class {
        constructor(config: BuiltConfig) {
          built.push(config);
        }
      },
    }));
    loaded = jest.requireActual<ClientModule>('../../../../../src/shared/codec/s3/client');
  });
  return loaded!;
}

/** The config `createDefaultS3Client` handed the SDK for `config`. */
async function builtFrom(config: object): Promise<BuiltConfig> {
  await capturingClientModule().createDefaultS3Client(config);
  return built[built.length - 1];
}

/** Its `requestHandler` options, read through the same capture. */
async function handlerFrom(config: object): Promise<HandlerOptions> {
  return (await builtFrom(config)).requestHandler!;
}

describe('the request-handler bound on an S3 client this library builds', () => {
  /** The dynamic import resolves inside the test, so unmock only once it is done. */
  afterEach(() => {
    jest.dontMock('@aws-sdk/client-s3');
    built.length = 0;
  });

  /**
   * `maxAttempts: 1` bounds how many attempts *start*; nothing bounded how
   * long one runs, because every request-handler timeout defaults to 0. This
   * is the one field that bounds it, and there is no second one: the handler
   * options are pinned whole, so a field added here fails.
   */
  it('passes exactly one request-handler field, the idle timer', async () => {
    expect(await handlerFrom({ region: 'us-east-1' })).toEqual({
      socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS,
    });
  });

  /**
   * Absent by name, because the symmetry with the DynamoDB client is the thing
   * a later reader will want to restore. `requestTimeout` bounds request
   * creation until response *headers* arrive, and a `PutObject`'s headers
   * arrive only once the whole body has been uploaded — so here it is a bound
   * on upload duration, over payloads running from the 350 KB offload
   * threshold to 50 MB. A legitimate large upload on a slow link would be
   * destroyed for being slow. The idle timer separates stalled from slow; a
   * request timeout cannot.
   */
  it('passes no requestTimeout, which on a PutObject would bound upload duration', async () => {
    expect(await handlerFrom({ region: 'us-east-1' })).not.toHaveProperty('requestTimeout');
  });

  /**
   * Absent rather than forgotten. The flag's only effect is on a breached
   * request timeout — it turns a logged warning into a destroyed, retryable
   * request — so with no request timeout there is nothing for it to act on.
   */
  it('passes no throwOnRequestTimeout, which without a request timeout has nothing to act on', async () => {
    expect(await handlerFrom({ region: 'us-east-1' })).not.toHaveProperty('throwOnRequestTimeout');
  });

  /**
   * `connectionTimeout` is absent for the reason measured on the DynamoDB
   * side: its timer counts the time a request spends queued behind the agent's
   * sockets, so a value short enough to be useful destroys healthy requests.
   * The S3 path fans out too.
   */
  it('passes no connectionTimeout, which would bound the queue rather than the connect', async () => {
    expect(await handlerFrom({ region: 'us-east-1' })).not.toHaveProperty('connectionTimeout');
  });

  /**
   * The documented escape hatch, and equally the documented way to give the
   * bound up: `config` spreads last, exactly as `maxAttempts` already behaves,
   * so a caller's own handler replaces this default whole rather than merging
   * with it.
   */
  it("lets a caller's own requestHandler replace the default wholesale", async () => {
    expect(await builtFrom({ requestHandler: { requestTimeout: 111 } })).toEqual({
      maxAttempts: 1,
      requestHandler: { requestTimeout: 111 },
    });
  });

  /**
   * The one place the two timers race, and the reason the value matters here
   * as well. Every offloaded payload at or above 2 MiB carries
   * `Expect: 100-continue` — the S3 middleware's own default — and the request
   * handler then waits `Math.max(6000, requestTimeout)` for the continue
   * before it writes the body, on a throwaway agent. With no request timeout
   * that wait is 6 000 ms flat, and the socket timer is registered before it
   * begins, so the idle timer has to be the shorter of the two or a stalled
   * large upload sits through the whole continue wait first. The same bound
   * keeps it under the 6 000 ms at which the handler stops installing the
   * socket listener immediately.
   */
  it('keeps the idle timer shorter than the 100-continue wait it has to fire inside', () => {
    expect(DEFAULT_SOCKET_TIMEOUT_MS).toBeLessThan(6000);
  });
});

describe('the same bound on an injected S3 client factory', () => {
  /**
   * `S3ClientLike.send` is typed `Promise<object>`; this fake never actually
   * calls S3 or throws. Returning `Promise.resolve({})` satisfies that type
   * without `async`: a non-async function that returns a `Promise` already
   * has type `Promise<T>`.
   */
  const fakeClient = () => ({
    send: jest.fn(() => Promise.resolve({})),
    destroy: jest.fn(),
  });

  /**
   * A caller who passes `createS3Client` is supplying a constructor, not a
   * configuration — they have not opted out of the bound — so the injected
   * path must hand over the same default as the built-in one. Nothing else
   * makes these two agree, so the assertion is written out rather than shared
   * with the built-in path's.
   */
  it('hands an injected factory the same request handler as the built-in path', async () => {
    const createS3Client = jest.fn(fakeClient);
    const offloader = new S3Offloader({ bucketName: 'b', createS3Client });
    await offloader.deleteBatch([]);
    expect(createS3Client).toHaveBeenCalledWith({
      maxAttempts: 1,
      requestHandler: { socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS },
    });
    offloader.destroy();
  });

  /** The same escape hatch on the same spread order, one path over. */
  it("lets a caller's own requestHandler replace it on the injected path too", async () => {
    const createS3Client = jest.fn(fakeClient);
    const offloader = new S3Offloader({
      bucketName: 'b',
      clientConfig: { requestHandler: { requestTimeout: 222 } },
      createS3Client,
    });
    await offloader.deleteBatch([]);
    expect(createS3Client).toHaveBeenCalledWith({
      maxAttempts: 1,
      requestHandler: { requestTimeout: 222 },
    });
    offloader.destroy();
  });
});

describe('a download that stalls after its response headers have arrived', () => {
  /** One chunk, then the read dies the way a destroyed socket kills it. */
  function abortingBody(): object {
    return {
      *[Symbol.asyncIterator]() {
        yield new Uint8Array([1]);
        throw Object.assign(new Error('aborted'), { code: 'ECONNRESET' });
      },
    };
  }

  /** Only what {@link downloadObject} calls on a client. */
  function clientYielding(bodies: object[]): { client: S3Client; calls: () => number } {
    let sent = 0;
    const client = {
      send: () => {
        sent += 1;
        return { Body: bodies[sent - 1] };
      },
    } as unknown as S3Client;
    return { client, calls: () => sent };
  }

  /**
   * The case the idle timer exists for on this client: the handler resolves at
   * the response *headers*, so a body stalling mid-stream is destroyed after
   * the promise has already settled. The rejection the handler prepares is
   * then discarded, and what reaches this library is the response stream's own
   * `ECONNRESET` rather than a `TimeoutError` — a different name for the same
   * event, and the reason both are in the shared classifier. The read runs
   * inside the retried closure, so the stalled attempt costs an attempt rather
   * than the download.
   */
  it('retries the aborted read the destroy produces, which carries no TimeoutError', async () => {
    const whole = { transformToByteArray: () => new Uint8Array([7, 8]) };
    const { client, calls } = clientYielding([abortingBody(), whole]);
    await expect(downloadObject(client, 'b', 'k.bin', 1024)).resolves.toEqual(
      new Uint8Array([7, 8]),
    );
    expect(calls()).toBe(2);
  });
});
