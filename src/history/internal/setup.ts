/**
 * Hides which options the history and its methods accept, and how the history
 * is assembled from them.
 *
 * The exhaustive key list of every option bag — the constructor's,
 * `getMessages`', `listSessions`' — lives here, compiler-checked against its
 * type, beside the code that resolves the constructor's options into the
 * context every action receives.
 */

import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { type AdapterCore, type AdapterShell, openAdapter } from '../../shared/adapter.js';
import { JSON_SERDE } from '../../shared/codec/json-serde.js';
import { validationError } from '../../shared/errors/errors.js';
import { createUlidFactory } from '../../shared/ulid.js';
import { allKeysOf, assertShape } from '../../shared/validation/option-shape.js';
import type {
  CorruptMessagePolicy,
  DynamoDBChatMessageHistoryOptions,
  GetMessagesOptions,
  ListSessionsOptions,
} from '../types.js';

/**
 * Max attempts for the message-append transaction. It shares one session's
 * metadata row across every concurrent `addMessages` caller on that session,
 * so a burst of concurrent appends can collide repeatedly; combined with the
 * existing 100ms base / 5000ms cap backoff, this keeps worst-case retrying
 * within AWS's documented guidance to bound conflict retries to "around one
 * minute" (see DynamoDB's "Error retries and exponential backoff" guide).
 * This bound is exact for clients this library constructs, which disable the
 * AWS SDK's own internal retries (`maxAttempts: 1`, see
 * `resolveDynamoDBClient`). An injected client that keeps SDK retries stacks
 * them inside each attempt; construction warns about that.
 */
export const MESSAGE_APPEND_RETRY_MAX_ATTEMPTS = 18;

/**
 * The keys of each chat-history option bag, exhaustive in both directions:
 * `allKeysOf<T>` makes omitting or inventing one a compile error, so a list
 * cannot rot away from the type it guards. They live with the feature because
 * the types they are checked against do; `shared/` knows no feature.
 */
export const HISTORY_KEYS = allKeysOf<DynamoDBChatMessageHistoryOptions>({
  tableName: 'tableName',
  client: 'client',
  clientConfig: 'clientConfig',
  createClient: 'createClient',
  ttl: 'ttl',
  logger: 'logger',
  retry: 'retry',
  indexShards: 'indexShards',
  indexName: 'indexName',
  readConcurrency: 'readConcurrency',
  compression: 'compression',
  s3: 's3',
  serde: 'serde',
  onCorruptMessage: 'onCorruptMessage',
});

/** See {@link HISTORY_KEYS}. */
export const GET_MESSAGES_KEYS = allKeysOf<GetMessagesOptions>({
  limit: 'limit',
  before: 'before',
  signal: 'signal',
});

/** See {@link HISTORY_KEYS}. */
export const LIST_SESSIONS_KEYS = allKeysOf<ListSessionsOptions>({
  limit: 'limit',
  cursor: 'cursor',
  maxIterations: 'maxIterations',
  maxItems: 'maxItems',
  signal: 'signal',
});

const CORRUPT_MESSAGE_POLICIES: readonly CorruptMessagePolicy[] = ['skip', 'throw'];

/** Reject an `onCorruptMessage` outside its union; see {@link setUpHistory} for why. */
function assertCorruptMessagePolicy(policy: CorruptMessagePolicy | undefined): void {
  if (policy !== undefined && !CORRUPT_MESSAGE_POLICIES.includes(policy)) {
    throw validationError(
      `onCorruptMessage must be one of ${CORRUPT_MESSAGE_POLICIES.join(' | ')}`,
      'onCorruptMessage',
    );
  }
}

/** Resolved collaborators shared by every chat-history action. */
export interface HistoryContext extends AdapterCore {
  serde: SerializerProtocol;
  ulid: () => string;
  onCorruptMessage: CorruptMessagePolicy;
}

/** Result of wiring up a chat-history adapter from its options. */
export interface HistorySetup {
  context: HistoryContext;
  shell: AdapterShell;
}

/**
 * Validate the options, then resolve the client, offloader and serializer.
 *
 * Accepts: `options` — validated first, so no half-built adapter exists when
 * one is wrong. `onCorruptMessage` is checked against its union here because a
 * JavaScript caller can pass a string the type never admits, and an
 * unrecognised policy would silently behave as `'skip'` — dropping messages a
 * caller asked to be told about.
 *
 * Returns: the context every action shares, and the shell that releases what
 * it holds — a client the caller passed in is never destroyed by `destroy()`.
 *
 * Throws: `VALIDATION` naming the offending option.
 *
 * Guarantees: constructing an adapter performs no I/O.
 */
export function setUpHistory(options: DynamoDBChatMessageHistoryOptions): HistorySetup {
  assertShape(options, HISTORY_KEYS, 'options');
  const shell = openAdapter(options, 'history', {
    options: () => assertCorruptMessagePolicy(options.onCorruptMessage),
    attemptFloor: MESSAGE_APPEND_RETRY_MAX_ATTEMPTS,
  });
  return {
    shell,
    context: {
      ...shell.core,
      serde: options.serde ?? JSON_SERDE,
      ulid: createUlidFactory(),
      onCorruptMessage: options.onCorruptMessage ?? 'skip',
    },
  };
}
