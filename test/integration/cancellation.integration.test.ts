import type { S3Client } from '@aws-sdk/client-s3';

import { DynamoDBSaver } from '../../src/index';
import { createDefaultS3Client } from '../../src/shared/codec/s3/client';
import { downloadObject } from '../../src/shared/codec/s3/offloader';
/**
 * What a caller's `abort()` does to a request that is already in flight.
 *
 * **This file does not use DynamoDB Local and does not need Docker.** Like
 * `request-bound.integration.test.ts`, whose fixture it reuses, it stands up
 * its own `node:http` servers in `beforeAll` and tears them down in
 * `afterAll`, so it runs whether or not the container is up.
 *
 * Why it lives here rather than in the unit tier. Every unit assertion about
 * cancellation can only show that the library hands `abortSignal` to a mocked
 * SDK; none of them can show that handing it over *ends a real request*. That
 * claim needs a real socket and a server that will not answer, which is
 * fifteen lines of `node:http` and no AWS at all.
 *
 * Each case measures the elapsed time against the bound that would otherwise
 * have ended the call, so "the abort did it" is an assertion rather than a
 * hope: a request the abort did not reach would end at the shipped idle timer
 * instead, seconds later, and with a different code.
 */
import { DEFAULT_SOCKET_TIMEOUT_MS } from '../../src/shared/dynamodb/client';
import { ErrorCode } from '../../src/shared/errors/error-code';
import { type MisbehavingServer, startMisbehavingServer } from './helpers/misbehaving-server';

const REGION = 'us-east-1';
const CREDENTIALS = { accessKeyId: 'test', secretAccessKey: 'test' };
const MAX_DOWNLOAD_BYTES = 1024 * 1024;

/**
 * Long enough that the request is provably in flight — the fixture counts it,
 * and the elapsed time is asserted to be at least this — and far short of
 * every bound that would otherwise end the call.
 */
const ABORT_AFTER_MS = 400;

/**
 * The idle timeout the S3 client is given for the stalled case. At and above
 * 6 000 ms the handler defers registering the socket listener and the headers
 * cancel that deferral, so nothing is ever armed — the twin cases in
 * `request-bound.integration.test.ts` measure exactly that. Choosing it here
 * is deliberate: it removes the only other thing that could release a stalled
 * body, so the abort is the sole candidate.
 */
const UNARMED_SOCKET_TIMEOUT_MS = 6_000;

let silent: MisbehavingServer;
let stalled: MisbehavingServer;
let healthyJson: MisbehavingServer;
let healthyBytes: MisbehavingServer;

const savers: { destroy: () => Promise<void> | void }[] = [];
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
  for (const saver of savers) await saver.destroy();
  for (const client of clients) client.destroy();
  await Promise.all([silent.close(), stalled.close(), healthyJson.close(), healthyBytes.close()]);
  process.stdout.write(`\ncancellation, measured: ${measured.join(' | ')}\n`);
});

/** A checkpointer built exactly as a consumer builds one, pointed at a fixture. */
function saverAt(url: string): DynamoDBSaver {
  const saver = new DynamoDBSaver({
    tableName: 'cancellation',
    clientConfig: { endpoint: url, region: REGION, credentials: CREDENTIALS },
  });
  savers.push(saver);
  return saver;
}

/** `forcePathStyle` keeps the bucket out of a hostname that `127.0.0.1` could not resolve. */
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

interface Outcome {
  error: Error & { code?: string };
  elapsedMs: number;
}

/**
 * Run `call` with a controller that fires part-way through, and report what it
 * rejected with and how long it took. A call that resolves is a failure of the
 * fixture, not a passing case, so it is reported as one.
 */
async function abortedDuring(call: (signal: AbortSignal) => Promise<unknown>): Promise<Outcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ABORT_AFTER_MS);
  const started = Date.now();
  try {
    await call(controller.signal);
    throw new Error('the call was expected to be cancelled and instead completed');
  } catch (error) {
    return { error: error as Error & { code?: string }, elapsedMs: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Keep the measurement, so a green run still prints what each cancel cost. */
function record(label: string, elapsedMs: number): void {
  measured.push(`${label} ${elapsedMs} ms`);
}

describe('(a) a DynamoDB request the server never answers', () => {
  /**
   * The whole chain, from the public method a consumer calls down to the
   * socket. Before the request options reached the SDK this call ran to the
   * shipped idle timer — five seconds — and came back as a `TimeoutError` the
   * retry layer then re-sent four more times, so a caller who cancelled waited
   * out the entire budget and was told its stop was a transport failure.
   *
   * Three assertions make the abort the cause rather than a coincidence: the
   * fixture received the request, the call outlived the abort delay, and it
   * ended well inside the timer that would otherwise have ended it.
   */
  it('is ended by the caller abort, as ABORTED, long before the shipped idle timer', async () => {
    const saver = saverAt(silent.url);
    const before = silent.requests();
    const { error, elapsedMs } = await abortedDuring((signal) =>
      saver.getTuple({ configurable: { thread_id: 't' }, signal }),
    );
    record('(a) getTuple cancelled after', elapsedMs);
    expect(silent.requests()).toBe(before + 1);
    expect(error.code).toBe(ErrorCode.ABORTED);
    expect(error.name).toBe('DynamoDBLangGraphError');
    expect(elapsedMs).toBeGreaterThanOrEqual(ABORT_AFTER_MS - 50);
    expect(elapsedMs).toBeLessThan(DEFAULT_SOCKET_TIMEOUT_MS);
  }, 30_000);

  /**
   * And it re-sends nothing. The transport rejects a cancelled request with an
   * error of its own, which the classifier would otherwise weigh on its
   * merits; the fixture's count is what shows the signal is read first.
   */
  it('re-sends nothing after the cancel', async () => {
    const saver = saverAt(silent.url);
    const before = silent.requests();
    await abortedDuring((signal) => saver.getTuple({ configurable: { thread_id: 't2' }, signal }));
    expect(silent.requests()).toBe(before + 1);
  }, 30_000);
});

describe('(b) an S3 body that stalls after its headers', () => {
  /**
   * The case no timeout covers. `requestTimeout` stopped applying when the
   * headers arrived, and at this idle timeout the socket listener is never
   * armed, so nothing at all would release this read — `request-bound`
   * measures it sitting unreleased for eight and a half seconds. The abort
   * listener is the one thing that outlives the headers.
   */
  it('is ended by the caller abort, where no timer of the handler would arm', async () => {
    const client = await s3At(stalled.url, UNARMED_SOCKET_TIMEOUT_MS);
    const { error, elapsedMs } = await abortedDuring((signal) =>
      downloadObject(
        client,
        { bucket: 'bucket', key: 'stall-abort.bin', maxBytes: MAX_DOWNLOAD_BYTES },
        signal,
      ),
    );
    record('(b) stalled download cancelled after', elapsedMs);
    expect(error.code).toBe(ErrorCode.ABORTED);
    expect(error.name).toBe('DynamoDBLangGraphError');
    expect(elapsedMs).toBeGreaterThanOrEqual(ABORT_AFTER_MS - 50);
    expect(elapsedMs).toBeLessThan(UNARMED_SOCKET_TIMEOUT_MS);
  }, 30_000);
});

describe('(c) the controls, so that (a) and (b) prove a cancel rather than a broken fixture', () => {
  it('completes a checkpointer read under a signal that never fires', async () => {
    const saver = saverAt(healthyJson.url);
    const controller = new AbortController();
    const before = healthyJson.requests();
    await expect(
      saver.getTuple({ configurable: { thread_id: 't' }, signal: controller.signal }),
    ).resolves.toBeUndefined();
    expect(healthyJson.requests()).toBe(before + 1);
  }, 30_000);

  it('completes an S3 download under a signal that never fires', async () => {
    const client = await s3At(healthyBytes.url, DEFAULT_SOCKET_TIMEOUT_MS);
    const controller = new AbortController();
    const bytes = await downloadObject(
      client,
      { bucket: 'bucket', key: 'healthy.bin', maxBytes: MAX_DOWNLOAD_BYTES },
      controller.signal,
    );
    expect(bytes).toEqual(new TextEncoder().encode('payload'));
  }, 30_000);
});
