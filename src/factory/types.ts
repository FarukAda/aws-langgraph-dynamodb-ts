import type { DynamoDBClient, DynamoDBClientConfig } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

import type { DynamoDBSaver } from '../checkpointer/saver';
import type { DynamoDBSaverOptions } from '../checkpointer/types';
import type { DynamoDBChatMessageHistory } from '../history/chat-message-history';
import type { DynamoDBChatMessageHistoryOptions } from '../history/types';
import type { CompressionConfig } from '../shared/codec/compression';
import type { S3OffloadConfig } from '../shared/codec/s3/config';
import type { RetryPolicy } from '../shared/dynamodb/retry-policy';
import type { Logger } from '../shared/logging/logger';
import type { TtlOption } from '../shared/validation/ttl';
import type { DynamoDBStore } from '../store/store';
import type { DynamoDBStoreOptions } from '../store/types';

/**
 * Defaults applied to every adapter the factory builds: the client (or how to
 * build one) and the cross-cutting options a team usually wants identical
 * across its checkpointer, store and history. A per-adapter option wins.
 */
export interface FactoryBaseOptions {
  /**
   * Reused as-is by every adapter. Construct it with `maxAttempts: 1`, or the
   * SDK's own retries stack inside the library's retry budget (each adapter
   * logs a `warn` at construction when they would).
   */
  client?: DynamoDBDocument;
  clientConfig?: DynamoDBClientConfig;
  /**
   * @internal Test seam and dependency-injection hook for constructing the
   * shared DynamoDB client; not part of the supported surface and absent from the
   * shipped declarations.
   */
  createClient?: (config: DynamoDBClientConfig) => DynamoDBClient;
  logger?: Logger;
  ttl?: TtlOption;
  compression?: CompressionConfig;
  s3?: S3OffloadConfig;
  retry?: RetryPolicy;
}

/** An adapter's own options inside {@link CreateAllOptions}: everything but the shared client. */
export type AdapterSection<Options> = Omit<Options, 'client' | 'clientConfig' | 'createClient'>;

/** Per-adapter options for `DynamoDBFactory.createAll`; omit a section to skip that adapter. */
export interface CreateAllOptions {
  saver?: AdapterSection<DynamoDBSaverOptions>;
  store?: AdapterSection<DynamoDBStoreOptions>;
  history?: AdapterSection<DynamoDBChatMessageHistoryOptions>;
}

/**
 * The adapters `createAll` built, typed by the sections it was given: an
 * omitted section is `undefined`. The default names the all-three result.
 */
export interface CreatedAdapters<O extends CreateAllOptions = Required<CreateAllOptions>> {
  saver: O extends { saver: object } ? DynamoDBSaver : undefined;
  store: O extends { store: object } ? DynamoDBStore : undefined;
  history: O extends { history: object } ? DynamoDBChatMessageHistory : undefined;
  /** Tear down every built adapter and the shared client, once. */
  destroy: () => void;
}
