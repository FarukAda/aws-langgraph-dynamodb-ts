/**
 * The per-attempt bound, against a server that misbehaves on purpose.
 *
 * **This file does not use DynamoDB Local and does not need Docker.** Every
 * other suite in this tier talks to the container; this one stands up its own
 * `node:http` servers in `beforeAll` and tears them down in `afterAll`, so it
 * runs whether or not the container is up. The next reader will assume
 * otherwise, which is why it says so here.
 *
 * It lives in this tier rather than the maintainer-run real-AWS one because
 * neither claim needs AWS: real S3 will not stall a body on demand, and a
 * socket that accepts and never answers is fifteen lines. This covers the
 * per-attempt half of the durability bound, which nothing else exercises;
 * filed under AWS it would be a manual step before a tag, and here it runs on
 * every push.
 *
 * Timing discipline. The shipped constants are used where the shipped
 * configuration is what is under test; short explicit values are used where
 * the mechanism is under test, so the whole file runs in seconds. Every case
 * says which of the two it is.
 */
import { GetObjectCommand, type S3Client } from '@aws-sdk/client-s3';

import { readBodyBounded, type S3Body } from '../../src/shared/codec/s3/bounded-body';
import { createDefaultS3Client } from '../../src/shared/codec/s3/client';
import { downloadObject } from '../../src/shared/codec/s3/read-write';
import { isTransientS3Error } from '../../src/shared/codec/s3/retry';
import { DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_SOCKET_TIMEOUT_MS } from '../../src/shared/constants';
import { resolveDynamoDBClient } from '../../src/shared/dynamodb/client';
import {
  DEFAULT_RETRYABLE_ERRORS,
  isRetryableError,
} from '../../src/shared/dynamodb/retry-classifier';
import { ErrorCode } from '../../src/shared/errors/error-code';
import { type MisbehavingServer, startMisbehavingServer } from './helpers/misbehaving-server';

const REGION = 'us-east-1';
const CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' };
const MAX_DOWNLOAD_BYTES = 1024 * 1024;

/**
 * Short explicit values, for the cases that are about the mechanism rather
 * than about the shipped numbers. `SHORT_REQUEST_TIMEOUT_MS` is deliberately
 * the shorter of the first pair, because the request timer is the only one
 * that produces `code: 'ETIMEDOUT'` and it has to win the race to do so — the
 * shipped pair is the other way round, which the case after it measures.
 */
const SHORT_REQUEST_TIMEOUT_MS = 300;
const LOSING_SOCKET_TIMEOUT_MS = 2_000;
const SHORT_SOCKET_TIMEOUT_MS = 400;

/**
 * At or above `DEFERRED_SOCKET_TIMEOUT_MS` the handler defers registering the
 * socket listener by 3 000 ms and returns *that* timer's id, which its
 * clear-on-resolve cancels when the response headers arrive — so the listener
 * is never installed. One millisecond below it, the listener is registered
 * immediately and survives. `DEFAULT_SOCKET_TIMEOUT_MS` is held under the
 * threshold by a unit assertion; the pair below is what makes that assertion
 * mean something.
 *
 * `STALL_WINDOW_MS` has to outlast the release a working timer at the
 * threshold would produce — measured at ~6 005 ms from request creation by the
 * twin below — and anything shorter would only prove the timer had not fired
 * early, which it would not have done either way. The ~2.5 s beyond that is
 * headroom for a contended machine, not a longer wait: `probeStall` races the
 * read against the window, so the released twin returns at its release and
 * only the never-released case sits out the full window. It is deliberately
 * short of 9 000 ms, the deferral plus its own timeout, which is the one
 * duration this case must *not* be read as waiting for.
 *
 * `DEFERRAL_MS` is the handler's own `DEFER_EVENT_LISTENER_TIME`. It is here
 * as the precondition of the 6 000 ms case rather than as a wait.
 */
const DEFERRED_SOCKET_TIMEOUT_MS = 6_000;
const ARMED_SOCKET_TIMEOUT_MS = 5_999;
const STALL_WINDOW_MS = 8_500;
const DEFERRAL_MS = 3_000;

let silent: MisbehavingServer;
let stalled: MisbehavingServer;
let healthyJson: MisbehavingServer;
let healthyBytes: MisbehavingServer;

const clients: { destroy: () => void }[] = [];
const measured: string[] = [];

beforeAll(async () => {
  [silent, stalled, healthyJson, healthyBytes] = await Promise.all([
    startMisbehavingServer({ behaviour: 'silent' }),
    startMisbehavingServer({ behaviour: 'stalled', body: 'first-chunk' }),
    startMisbehavingServer({
      behaviour: 'healthy',
      body: '{}',
      contentType: 'application/x-amz-json-1.0',
    }),
    startMisbehavingServer({ behaviour: 'healthy', body: 'payload' }),
  ]);
});

afterAll(async () => {
  for (const client of clients) client.destroy();
  await Promise.all([silent.close(), stalled.close(), healthyJson.close(), healthyBytes.close()]);
  process.stdout.write(`\nper-attempt bound, measured: ${measured.join(' | ')}\n`);
});

/** A DocumentClient this library builds, pointed at a fixture through `endpoint` alone. */
function dynamodbAt(url: string, requestHandler?: object) {
  const { client, ddbClient } = resolveDynamoDBClient({
    clientConfig: {
      endpoint: url,
      region: REGION,
      credentials: CREDENTIALS,
      ...(requestHandler ? { requestHandler } : {}),
    },
  });
  if (ddbClient) clients.push(ddbClient);
  return client;
}

/**
 * An S3 client this library builds, pointed at a fixture. `forcePathStyle`
 * keeps the bucket out of the hostname, which on `127.0.0.1` would not resolve;
 * `requestHandler` replaces the library's default whole, which is how the
 * shipped idle timer is swapped for a short one.
 */
async function s3At(url: string, socketTimeout: number): Promise<S3Client> {
  const client = await createDefaultS3Client({
    endpoint: url,
    region: REGION,
    credentials: CREDENTIALS,
    forcePathStyle: true,
    requestHandler: { socketTimeout },
  });
  clients.push(client);
  return client;
}

/** The stalled body, read the way the download path reads it. */
async function stalledBody(client: S3Client, key: string): Promise<S3Body> {
  const response = await client.send(new GetObjectCommand({ Bucket: 'bucket', Key: key }));
  return response.Body as unknown as S3Body;
}

interface Failure {
  error: Error & { code?: string };
  elapsedMs: number;
}

/** Run `call`, require it to fail, and report what failed and how long it took. */
async function failureOf(call: () => Promise<unknown>): Promise<Failure> {
  const started = Date.now();
  try {
    await call();
  } catch (error) {
    return { error: error as Error & { code?: string }, elapsedMs: Date.now() - started };
  }
  throw new Error('the call was expected to fail within its bound and did not');
}

/** Keep the measurement, so a green run still prints what each bound cost. */
function record(label: string, elapsedMs: number): void {
  measured.push(`${label} ${elapsedMs} ms`);
}

interface StallProbe {
  /** How long after request creation the response *headers* arrived. */
  headersAtMs: number;
  /** What the read had done within the window; `undefined` means nothing released it in it. */
  atWindow: string | undefined;
  /** How long after request creation something released it, if anything did. */
  releasedAtMs: number | undefined;
  /** What it ended as once the connection was dropped, which always ends it. */
  final: string | undefined;
}

/**
 * Start a stalled read under `socketTimeout`, watch it until something
 * releases it or `STALL_WINDOW_MS` from request creation passes — whichever
 * comes first — then drop the connection so the read always ends and no socket
 * outlives the test. Asserting that something does *not* happen needs both
 * halves: the silence, and the proof the read was live through it.
 *
 * Racing the read against the window rather than always sitting out the window
 * is what buys the window its headroom: the twin that *is* released returns
 * when it is released, so widening the window past anything a loaded machine
 * might do costs the pair nothing.
 *
 * `headersAtMs` is the precondition the 6 000 ms case rests on and would
 * otherwise leave unsaid. Nothing is armed there only because the headers
 * cancel the deferral before its 3 000 ms elapse; a machine slow enough to
 * miss that is exercising a different path and has to say so rather than
 * surfacing as a released stall.
 */
async function probeStall(socketTimeout: number): Promise<StallProbe> {
  const client = await s3At(stalled.url, socketTimeout);
  const started = Date.now();
  const body = await stalledBody(client, `stall-${socketTimeout}.bin`);
  const headersAtMs = Date.now() - started;
  let outcome: string | undefined;
  let releasedAtMs: number | undefined;
  const mark = (result: string) => {
    outcome = result;
    releasedAtMs = Date.now() - started;
  };
  const read = readBodyBounded(body, 'stall.bin', MAX_DOWNLOAD_BYTES).then(
    () => mark('resolved'),
    (error: Error & { code?: string }) => mark(`rejected:${error.code}`),
  );
  let windowTimer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    read,
    new Promise<void>((resolve) => {
      windowTimer = setTimeout(resolve, STALL_WINDOW_MS - (Date.now() - started));
    }),
  ]);
  clearTimeout(windowTimer);
  const atWindow = outcome;
  stalled.dropConnections();
  await read;
  return { headersAtMs, atWindow, releasedAtMs, final: outcome };
}

describe('(a) a request that is never answered', () => {
  /**
   * Mechanism, so short explicit values. `throwOnRequestTimeout` — which this
   * library sets on every DynamoDB client it builds — is what turns the
   * handler's logged warning into a destroyed request, and the error it
   * rejects with is the only one in either path carrying `code: 'ETIMEDOUT'`.
   * The claim asserted here is that *this library* retries it, so the verdict
   * comes from the library's own classifier rather than from reading the name.
   */
  it('is failed by the request timeout as a retryable ETIMEDOUT', async () => {
    const client = dynamodbAt(silent.url, {
      requestTimeout: SHORT_REQUEST_TIMEOUT_MS,
      socketTimeout: LOSING_SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    });
    const before = silent.requests();
    const { error, elapsedMs } = await failureOf(() =>
      client.get({ TableName: 'unanswered', Key: { PK: 'p', SK: 's' } }),
    );
    record('(a) request timeout', elapsedMs);
    expect(silent.requests()).toBe(before + 1);
    expect(error.name).toBe('TimeoutError');
    expect(error.code).toBe('ETIMEDOUT');
    expect(isRetryableError(error, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
    expect(elapsedMs).toBeLessThan(LOSING_SOCKET_TIMEOUT_MS);
  }, 15_000);

  /**
   * The shipped configuration, so the shipped constants — and the surprise
   * they hold. It would be easy to assume a never-answered request times out
   * via `requestTimeout`, but the DynamoDB client carries a 10 000 ms request
   * timeout against a 5 000 ms idle timer, and a socket that has been written
   * to and then goes quiet is idle: the *socket* timer fires first, at five
   * seconds, and the request timer never runs. The attempt is still bounded
   * and still classified retryable — that is the half that matters; the timer
   * that does it is not the one a reader would guess. Pinned by message, so a
   * smithy change that reorders
   * them fails here rather than silently — and by the absent `code`, because
   * `setSocketTimeout`'s rejection carries `name` alone, so `ETIMEDOUT` never
   * reaches a caller of the shipped configuration and only the `TimeoutError`
   * token in {@link DEFAULT_RETRYABLE_ERRORS} makes the retry happen.
   */
  it('is bounded by the shipped pair — by the idle timer, not the request timer', async () => {
    const client = dynamodbAt(silent.url);
    const { error, elapsedMs } = await failureOf(() =>
      client.get({ TableName: 'unanswered', Key: { PK: 'p', SK: 's' } }),
    );
    record('(a) shipped pair', elapsedMs);
    expect(error.name).toBe('TimeoutError');
    expect(error.message).toContain(`socket timed out after ${DEFAULT_SOCKET_TIMEOUT_MS} ms`);
    expect(error.code).toBeUndefined();
    expect(isRetryableError(error, DEFAULT_RETRYABLE_ERRORS)).toBe(true);
    expect(elapsedMs).toBeGreaterThanOrEqual(DEFAULT_SOCKET_TIMEOUT_MS - 300);
    expect(elapsedMs).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MS);
  }, 30_000);
});

describe('(b) a response whose headers arrive and whose body then stalls', () => {
  /**
   * Mechanism, so a short explicit idle timer. This is the case
   * `requestTimeout` provably does not cover: the handler's promise resolved
   * at the headers and `clearTimeouts()` ran there, so what releases the read
   * is the socket listener that survived — it was registered immediately
   * (below 6 000 ms) and `clearTimeout(0)` ignored its returned id. The
   * rejection it prepares is discarded by the already-settled promise, so what
   * reaches the caller is the response stream's own abort.
   */
  it('is released by the socket timeout, as ECONNRESET rather than a TimeoutError', async () => {
    const client = await s3At(stalled.url, SHORT_SOCKET_TIMEOUT_MS);
    const body = await stalledBody(client, 'stalled.bin');
    const { error, elapsedMs } = await failureOf(() =>
      readBodyBounded(body, 'stalled.bin', MAX_DOWNLOAD_BYTES),
    );
    record('(b) stalled body released', elapsedMs);
    expect(error.name).not.toBe('TimeoutError');
    expect(error.code).toBe('ECONNRESET');
    expect(isTransientS3Error(error)).toBe(true);
    expect(elapsedMs).toBeLessThan(SHORT_SOCKET_TIMEOUT_MS + 2_000);
  }, 15_000);

  /**
   * The same stall through the production download path, which is where it
   * has to end up as something a caller can act on. The read runs inside the
   * retried closure, so the stalled attempt costs an attempt rather than the
   * download; three of them are spent and the budget ends as a typed
   * `S3_OFFLOAD_FAILED` whose cause chain the library's own classifier still
   * reads as transient, two wrappers deep.
   */
  it('reaches the download path as a retryable S3_OFFLOAD_FAILED, not as a hang', async () => {
    const client = await s3At(stalled.url, SHORT_SOCKET_TIMEOUT_MS);
    const { error, elapsedMs } = await failureOf(() =>
      downloadObject(client, 'bucket', 'stalled.bin', MAX_DOWNLOAD_BYTES),
    );
    record('(b) download path exhausted', elapsedMs);
    expect(error.code).toBe(ErrorCode.S3_OFFLOAD_FAILED);
    expect(isTransientS3Error(error)).toBe(true);
    expect(elapsedMs).toBeLessThan(6_000);
  }, 20_000);
});

describe('(c) the control, so that (a) and (b) prove a timeout rather than a broken fixture', () => {
  it('completes a DynamoDB call against the healthy route', async () => {
    const client = dynamodbAt(healthyJson.url);
    const result = await client.get({ TableName: 'healthy', Key: { PK: 'p', SK: 's' } });
    expect(result.$metadata.httpStatusCode).toBe(200);
    expect(result.Item).toBeUndefined();
    expect(healthyJson.requests()).toBe(1);
  }, 15_000);

  /** The shipped idle timer, because here the shipped configuration is what has to complete. */
  it('completes an S3 download against the healthy route', async () => {
    const client = await s3At(healthyBytes.url, DEFAULT_SOCKET_TIMEOUT_MS);
    const bytes = await downloadObject(client, 'bucket', 'healthy.bin', MAX_DOWNLOAD_BYTES);
    expect(bytes).toEqual(new TextEncoder().encode('payload'));
    expect(healthyBytes.requests()).toBe(1);
  }, 15_000);
});

describe('(d) the same stall, either side of the deferral threshold', () => {
  /**
   * The twin that makes the case after it an assertion rather than an absence.
   * One millisecond under the threshold the listener is registered immediately,
   * `setSocketTimeout` returns the literal `0`, and `clearTimeout(0)` on the
   * resolve ignores it — so the listener survives the headers and releases the
   * stall at its own timeout, inside the very same window. Without this,
   * "nothing released it at 6 000" would be satisfied by a window too short to
   * catch a working timer.
   */
  it('is released at 5 999, where the listener is registered immediately', async () => {
    const probe = await probeStall(ARMED_SOCKET_TIMEOUT_MS);
    record('(d) released at 5 999 after', probe.releasedAtMs ?? -1);
    expect(probe.atWindow).toBe('rejected:ECONNRESET');
    expect(probe.releasedAtMs).toBeGreaterThanOrEqual(ARMED_SOCKET_TIMEOUT_MS - 500);
    expect(probe.releasedAtMs).toBeLessThan(STALL_WINDOW_MS);
  }, 30_000);

  /**
   * Why `DEFAULT_SOCKET_TIMEOUT_MS < 6000` is a bound and not a number in a
   * file. At 6 000 the handler does not register the socket listener at all:
   * it defers registration by 3 000 ms and returns the deferral's timer id,
   * which `clearTimeouts()` cancels when the headers arrive — about ten
   * milliseconds in. Nothing is ever armed, so the stalled body is never
   * released, and the one bound a stalled transfer has is gone.
   *
   * Dropping the connection settles the other half: the read was live the
   * whole time and rejects the moment anything releases it, so its silence was
   * the timer's absence rather than a dead promise. The headers assertion
   * settles the third: they have to land inside the deferral for it to be
   * cancelled, and a machine slow enough to miss that would arm the listener
   * after all — a different mechanism, and one this case should report rather
   * than fail obscurely inside.
   */
  it('is not released at all at 6 000, because registration is deferred then cancelled', async () => {
    const probe = await probeStall(DEFERRED_SOCKET_TIMEOUT_MS);
    record('(d) still pending at 6 000 after', STALL_WINDOW_MS);
    expect(probe.headersAtMs).toBeLessThan(DEFERRAL_MS);
    expect(probe.atWindow).toBeUndefined();
    expect(probe.final).toBe('rejected:ECONNRESET');
  }, 30_000);
});
