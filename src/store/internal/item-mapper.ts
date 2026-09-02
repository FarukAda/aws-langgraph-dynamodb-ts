import type { Item } from '@langchain/langgraph-checkpoint';

import { type CodecDeps, decodePayload, encodePayload } from '../../shared/codec/codec';
import type { DocItem } from '../../shared/dynamodb/types';
import type { StoreItemRecord } from '../types';
import type { JsonValue } from './filter';
import { partitionKey, sortKey } from './keys';
import type { StoreContext } from './setup';

/**
 * Narrow a raw scanned row to a {@link StoreItemRecord}, or `undefined` for a
 * foreign row on a shared table (no `namespace`) — and for a row whose
 * `namespace`/`key` attributes disagree with the DynamoDB key it was found at.
 * The attributes name the S3 path the row may reference, so they must be bound
 * to the partition the row actually lives in: a writer confined to its own
 * partition can then never make a row speak for another tenant's objects.
 */
export function narrowStoreRecord(raw: DocItem): StoreItemRecord | undefined {
  if (!Array.isArray(raw.namespace) || typeof raw.key !== 'string') return undefined;
  const record = raw as StoreItemRecord;
  const consistent =
    record.PK === partitionKey(record.namespace) &&
    record.SK === sortKey(record.namespace, record.key);
  return consistent ? record : undefined;
}

/** Map a store context to the codec collaborators. */
function storeCodecDeps(context: StoreContext): CodecDeps {
  return { serde: context.serde, compression: context.compression, offloader: context.offloader };
}

/** Fields controlling a stored item's timestamps, embedding, ttl, and S3 key nonce. */
export interface BuildItemOptions {
  createdAt: string;
  updatedAt: string;
  embedding?: number[];
  ttlTimestamp?: number;
  /** Per-call nonce: uniquifies the S3 key and becomes the row's revision token. */
  nonce?: string;
}

/** Encode a value into the DynamoDB record for a stored item. */
export async function buildStoreItem(
  context: StoreContext,
  namespace: string[],
  key: string,
  value: Record<string, JsonValue>,
  options: BuildItemOptions,
): Promise<StoreItemRecord> {
  const descriptor = await encodePayload(value, storeCodecDeps(context), {
    keyParts:
      options.nonce === undefined ? [...namespace, key] : [...namespace, key, options.nonce],
  });
  const record: StoreItemRecord = {
    PK: partitionKey(namespace),
    SK: sortKey(namespace, key),
    namespace,
    key,
    value: descriptor,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
  };
  if (options.embedding) record.embedding = options.embedding;
  if (options.ttlTimestamp !== undefined) record.ttl = options.ttlTimestamp;
  if (options.nonce !== undefined) record.rev = options.nonce;
  return record;
}

/** Decode a DynamoDB record back into a store {@link Item}. */
export async function readStoreItem(context: StoreContext, record: StoreItemRecord): Promise<Item> {
  const value = await decodePayload<Record<string, JsonValue>>(
    record.value,
    storeCodecDeps(context),
    [...record.namespace, record.key],
  );
  return {
    namespace: record.namespace,
    key: record.key,
    value,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}
