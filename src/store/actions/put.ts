import { randomUUID } from 'node:crypto';

import { nowIso } from '../../shared/clock';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { deleteStoreItem } from '../internal/delete-item';
import type { JsonValue } from '../internal/filter';
import { syncVectorIndex } from '../internal/index-sync';
import type { ParsedDelete, ParsedPut } from '../internal/parse';
import { persistRecord } from '../internal/persist';
import { buildStoreItem, itemRowKey, readExisting } from '../internal/rows';
import { embedPassages, embedValue } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';

/**
 * The vectors a put stores on the row: one per extracted path, scored by best
 * match on read. Not computed when a `vectorBackend` holds the vectors, which
 * takes a single vector per item instead (see {@link resolveEmbedding}).
 */
async function resolvePassages(
  context: StoreContext,
  op: ParsedPut,
  value: Record<string, JsonValue>,
): Promise<number[][] | undefined> {
  if (op.index === false) return undefined;
  return embedPassages(context, value, op.index);
}

/** Compute the single joined embedding a `vectorBackend` indexes, honoring `op.index`. */
async function resolveEmbedding(
  context: StoreContext,
  op: ParsedPut,
  value: Record<string, JsonValue>,
): Promise<number[] | undefined> {
  if (op.index === false) return undefined;
  return embedValue(context, value, op.index);
}

/**
 * Store, update or delete an item.
 *
 * Accepts: `op` — parsed; a `ParsedDelete` removes the item, a `ParsedPut` is
 * stored, its value encoded with optional compression and S3 offload under
 * this row's own path, in an object named by this put's own id. `op.index` —
 * `false` stores the item without indexing it and clears any vector it had, an
 * array overrides the configured fields for this put, and absent uses the
 * store's configuration.
 *
 * Returns: nothing. Deleting an item that is not there is not an error.
 *
 * Throws: `VALIDATION` naming `value` for a value that JSON cannot represent —
 * refused at the write rather than stored as a row that can never be read back;
 * `S3_OFFLOAD_FAILED`; whatever the write throws.
 *
 * Guarantees: DynamoDB holds the canonical item — the vector index is synced
 * afterwards and best-effort, so a backend outage never fails a put or leaves a
 * half-written item. `createdAt` survives every update. The superseded payload
 * is deleted only once the new row is committed, and this put's own upload
 * only once a read proves its write did not land. Neither release reads the
 * row first: each put uploads under a key ending in an id of its own, so the
 * object a put uploads is named only by that put's own rows.
 */
export async function putItem(context: StoreContext, op: ParsedPut | ParsedDelete): Promise<void> {
  if (op.kind === 'delete') {
    await deleteStoreItem(context, op.address);
    return;
  }
  const { namespace, key } = op.address;
  const value = op.value;
  const timestamp = nowIso();
  const existing = await readExisting(context, itemRowKey(op.address));
  /**
   * The two indexing modes are exclusive, so only one of them embeds: the row
   * carries a vector per extracted path, while a configured backend takes one
   * vector per item because that is what its `upsert` contract addresses.
   */
  const backend = context.vectorBackend;
  const embedding = backend ? await resolveEmbedding(context, op, value) : undefined;
  const embeddings = backend ? undefined : await resolvePassages(context, op, value);
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const record = await buildStoreItem(context, { namespace, key }, value, {
    createdAt: existing.createdAt ?? timestamp,
    updatedAt: timestamp,
    embeddings,
    ttlTimestamp,
    rev: randomUUID(),
  });
  await persistRecord(context, record, existing);
  if (backend) {
    await syncVectorIndex(backend, namespace, key, embedding, context.logger);
  }
}
