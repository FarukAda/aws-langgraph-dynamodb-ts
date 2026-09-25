/**
 * Hides the DynamoDB client: the part of the DocumentClient this package calls,
 * the item shapes that part speaks, and how a client this package builds bounds
 * each request.
 *
 * The structural type is what lets a caller inject any DocumentClient-shaped
 * object, and it is public; the item shapes travel through every module that
 * reads or writes a row; the construction is the one place a request timeout
 * and a socket timeout are set, and the one place that knows whether the
 * adapter owns the client it holds.
 */

import { DynamoDBClient, type DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocument,
  type NativeAttributeValue,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';

import type { Logger } from '../logging/logger';

/**
 * How long one request attempt may take on a client this library builds
 * (10 seconds) before the SDK's request handler destroys it and rejects with a
 * retryable `TimeoutError`. `MAX_WRITE_LIFETIME_MS`
 * (`src/shared/dynamodb/retry.ts`) bounds how many attempts *start*; it is
 * checked between them, so it can refuse to begin another wait and can never
 * shorten the attempt already in flight. Without a handler timeout — every one
 * of them defaults to 0 — a hung socket holds that attempt open forever and
 * the write lifetime bounds nothing.
 *
 * Measured, not picked. Across the fan-out widths this package documents, the
 * worst interval the handler itself saw — socket acquisition including the
 * wait behind the agent's fifty sockets, connect, request write and
 * time-to-first-response-header — was 0.92 s, at a thousand concurrent writes
 * of 20 KB values, and ten seconds is roughly eleven times that. The asymmetry
 * settles the close call: too large leaves one attempt hanging for at most ten
 * seconds, which the write lifetime's own headroom absorbs, while too small
 * turns a healthy wide fan-out into a retry storm.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

/**
 * How long a socket may sit idle (5 seconds) on a client this library builds
 * before the request handler destroys the request. Which error that surfaces
 * as depends on when it fires: before response headers the handler's own
 * rejection reaches the caller as a `TimeoutError`, while after them the call
 * has already resolved and the destroy arrives through the response stream
 * instead, as an `ECONNRESET` abort. Both are classified retryable, so either
 * way a stalled transfer becomes a retry of this library's own. An idle timer
 * rather than a deadline: activity in either direction resets it, so it bounds
 * a transfer that has stalled and never one that is merely slow, and its clock
 * starts at socket assignment rather than at request creation. What each
 * client needs it *for* differs, so that belongs at each client's own call
 * site rather than here.
 *
 * Not a tuning knob. The handler installs the socket listener immediately only
 * below 6 000 ms; at or above that it defers registration by 3 000 ms and
 * returns the deferral's timer id, which the handler's clear-on-resolve
 * cancels when response headers arrive — so at 6 000 or more the field
 * silently stops doing anything for every response that answers inside three
 * seconds, which is the normal case. That is a fact about the request handler
 * and about neither client. A unit assertion holds this value under that
 * threshold so raising it fails loudly instead of disabling the only bound a
 * stalled transfer has.
 */
export const DEFAULT_SOCKET_TIMEOUT_MS = 5_000;

/** A resolved DynamoDB client plus its ownership flag. */
export interface ResolvedDynamoDBClient {
  ddbClient: DynamoDBClient | undefined;
  client: DynamoDBDocumentLike;
  ownsClient: boolean;
}

/** Options for {@link resolveDynamoDBClient}. */
export interface ResolveClientOptions {
  client?: DynamoDBDocumentLike;
  clientConfig?: DynamoDBClientConfig;
  /** @internal Test seam and dependency-injection hook for constructing the client. */
  createClient?: (config: DynamoDBClientConfig) => DynamoDBClient;
}

/**
 * The DocumentClient an adapter will use, and whether it owns it.
 *
 * Accepts: `client` — an injected DocumentClient, used as-is; `clientConfig` —
 * what one is built from when no client is injected; `createClient` — the test
 * seam that builds it. `assertBaseAdapterOptions` rejects an injected client
 * given alongside either of the other two, so only one branch is ever taken.
 *
 * Returns: the document client, the raw client behind it when this call built
 * one, and `ownsClient` — true only then. An injected client is never
 * destroyed by `destroy()`; it may be shared with the caller's own code and
 * with the other adapters.
 *
 * Throws: whatever the SDK constructor throws for an unusable config.
 *
 * Guarantees: a client this call builds gets `maxAttempts: 1` unless the config
 * overrides it, so the SDK performs no retries of its own and this library's
 * retry layer is the only one. It also gets a default request handler that
 * bounds how long one attempt may run, which `maxAttempts` alone does not. A
 * `requestHandler` in `clientConfig` replaces that default whole rather than
 * merging with it — the documented escape hatch, and equally the documented
 * way to give up the bound. An injected client keeps whatever it was built
 * with — see {@link warnOnStackedRetries}.
 */
export function resolveDynamoDBClient(options: ResolveClientOptions): ResolvedDynamoDBClient {
  if (options.client) {
    return { ddbClient: undefined, client: options.client, ownsClient: false };
  }
  const createClient = options.createClient ?? ((config) => new DynamoDBClient(config));
  /**
   * `throwOnRequestTimeout` is what makes the request timeout a bound: without
   * it the handler only logs a warning when the timeout is breached.
   * `socketTimeout` is here because `requestTimeout` stops applying the moment
   * response *headers* arrive — the handler resolves there and clears its
   * timers — so it says nothing about a response body that then stalls
   * mid-stream, and an idle timer does. No `connectionTimeout` is passed,
   * deliberately — its timer starts when the request is created and is
   * cleared only when the agent *assigns* a socket, so the time a request
   * spends queued behind `maxSockets` counts against it. At the thousand-wide
   * fan-out this package documents, any value short enough to be useful
   * destroys healthy writes that this library then retries, and any value
   * long enough to be safe bounds nothing the request timeout does not
   * already bound.
   */
  const ddbClient = createClient({
    maxAttempts: 1,
    requestHandler: {
      requestTimeout: DEFAULT_REQUEST_TIMEOUT_MS,
      socketTimeout: DEFAULT_SOCKET_TIMEOUT_MS,
      throwOnRequestTimeout: true,
    },
    ...options.clientConfig,
  });
  return { ddbClient, client: DynamoDBDocument.from(ddbClient), ownsClient: true };
}

/**
 * Warn once when an injected client keeps the SDK's own retries.
 *
 * Accepts: `client` — the caller's. A client that cannot report its setting —
 * a stub, a mock, a future SDK shape — is left alone.
 *
 * Returns: nothing. Deliberately not awaited by its callers: it is a warning
 * about a caller-supplied client, not a precondition for using it, so
 * constructing an adapter stays free of I/O.
 *
 * Throws: nothing, ever. The SDK's own config resolution can reject, and a
 * rejection here would surface as an unhandled rejection from a constructor
 * that did nothing wrong.
 *
 * Guarantees: the SDK's retries run inside every attempt of this library's
 * retry layer, so the budget the constants and README describe multiplies (5 ×
 * 3 requests per operation at the SDK default) and a throttling event turns
 * into a retry storm. Saying so once, at construction, is the only place the
 * caller can act on it.
 *
 * The one gap a deadline cannot cover. A tokened write's budget is bounded by
 * `MAX_WRITE_LIFETIME_MS`, but that bound is checked between attempts: it can
 * refuse to start another wait, and it cannot shorten an attempt already in
 * flight. An injected client that retries internally turns one of this
 * library's attempts into several of its own, so the time spent inside a
 * single attempt stops being bounded by anything this library sets — which is
 * why the warning says to construct it with `maxAttempts: 1`.
 *
 * `maxAttempts: 1` is necessary but not sufficient. The per-attempt bound
 * holds for an injected client only if it also carries its own request
 * timeout: a client this library builds is given one
 * ({@link resolveDynamoDBClient}), and an injected client is used exactly as
 * handed over, so one without a handler timeout leaves a single attempt
 * unbounded even with the SDK's retries switched off.
 */
export async function warnOnStackedRetries(
  client: DynamoDBDocumentLike,
  logger: Logger,
): Promise<void> {
  const report = (client as { config?: { maxAttempts?: () => Promise<number> } }).config
    ?.maxAttempts;
  if (typeof report !== 'function') return;
  try {
    const maxAttempts = await report();
    if (maxAttempts > 1) {
      logger.warn(
        "injected DynamoDB client keeps the SDK's own retries; they stack inside this library's " +
          'retry budget — construct it with maxAttempts: 1 unless that is intended',
        { maxAttempts },
      );
    }
  } catch {
    // A client that cannot report its retry setting is left alone.
  }
}

/**
 * A DynamoDB item as returned/accepted by the DocumentClient. Reads that we
 * wrote ourselves are narrowed with a single structural `as` at the mapper
 * boundary (never `as any`/`as unknown`); untrusted shared-table scans go
 * through `narrowStoreRecord`.
 */
export type DocItem = Record<string, NativeAttributeValue>;

/** A BatchWriteItem PutRequest. */
interface PutWriteRequest {
  PutRequest: { Item: DocItem };
}

/** A BatchWriteItem DeleteRequest. */
interface DeleteWriteRequest {
  DeleteRequest: { Key: DocItem };
}

/** A single BatchWriteItem write request. */
export type WriteRequest = PutWriteRequest | DeleteWriteRequest;

/** One action of a `TransactWriteItems` request, as the document client takes it. */
export type TransactAction = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/**
 * The DocumentClient surface this library uses, named by shape rather than by
 * identity. A `DynamoDBDocument` satisfies it, and so does a client built from
 * a different copy of `@aws-sdk/lib-dynamodb`.
 *
 * That second case is the reason it exists. A consumer pinned to an older SDK
 * than this package depends on gets a second, newer copy nested under the
 * package; naming `DynamoDBDocument` in an option type would name *that* copy,
 * and the client the consumer built is then a different type with the same
 * name — refused at compile time for a method this library never calls, on the
 * injection path the documentation recommends. Injection always worked at
 * runtime; only the compiler stood in the way.
 *
 * The members are the eight the runtime collaborator check already requires,
 * pinned equal to that list by a test — a client this type accepts and the
 * constructor then rejects, or the reverse, would be worse than either rule
 * alone. Picking them off `DynamoDBDocument` keeps each signature the SDK's
 * own, so the internals stay exactly as type-safe as they were and the
 * signatures cannot drift from the SDK this package installs.
 */
export type DynamoDBDocumentLike = Pick<
  DynamoDBDocument,
  'batchWrite' | 'delete' | 'get' | 'put' | 'query' | 'scan' | 'transactWrite' | 'update'
>;
