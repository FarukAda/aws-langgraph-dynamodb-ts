import type { Item } from '@langchain/langgraph-checkpoint';

import { type CodecDeps, decodePayload, encodePayload } from '../../shared/codec/codec';
import type { DocItem } from '../../shared/dynamodb/types';
import type { StoreItemRecord } from '../types';
import type { JsonValue } from './filter';
import { partitionKey, sortKey } from './keys';
import type { StoreContext } from './setup';

/**
 * Narrow a raw scanned row to a {@link StoreItemRecord}, or `undefined` for a
 * foreign row on a shared table (no `namespace`). Replaces an unchecked cast at
 * the scan boundary, the one place rows are not written by this library.
 */
export function narrowStoreRecord(raw: DocItem): StoreItemRecord | undefined {
  return Array.isArray(raw.namespace) ? (raw as StoreItemRecord) : undefined;
}

/** Map a store context to the codec collaborators. */
function storeCodecDeps(context: StoreContext): CodecDeps {
  return { serde: context.serde, compression: context.compression, offloader: context.offloader };
}

/** Fields controlling a stored item's timestamps, embedding, and ttl. */
export interface BuildItemOptions {
  createdAt: string;
  updatedAt: string;
  embedding?: number[];
  ttlTimestamp?: number;
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
    keyParts: [...namespace, key],
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
  return record;
}

/** Decode a DynamoDB record back into a store {@link Item}. */
export async function readStoreItem(context: StoreContext, record: StoreItemRecord): Promise<Item> {
  const value = await decodePayload<Record<string, JsonValue>>(
    record.value,
    storeCodecDeps(context),
  );
  return {
    namespace: record.namespace,
    key: record.key,
    value,
    createdAt: new Date(record.createdAt),
    updatedAt: new Date(record.updatedAt),
  };
}
