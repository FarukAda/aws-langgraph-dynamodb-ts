/**
 * Hides the order a put happens in.
 *
 * A put reads the row it replaces for its `createdAt`, embeds once — a vector
 * per extracted path onto the row, or one vector for the `vectorBackend`,
 * never both — writes the row, and only then syncs the backend, best-effort.
 * A `null` value takes the delete path instead. A caller hands over an item;
 * that the table commits first and the vector copy follows is decided here.
 */

import { randomUUID } from 'node:crypto';

import { nowIso } from '../../shared/clock';
import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import type { JsonValue } from '../internal/filter';
import { deleteStoreItem, persistRow } from '../internal/item-write';
import type { ParsedDelete, ParsedPut } from '../internal/parse';
import { buildStoreRow, itemRowKey, readExisting } from '../internal/rows';
import { embedPassages } from '../internal/semantic-search';
import type { StoreContext } from '../internal/setup';
import { itemVector, syncItemVector } from '../internal/vector-index';

/**
 * The vectors a put stores on the row: one per extracted path, scored by best
 * match on read. Not computed when a `vectorBackend` holds the vectors, which
 * takes a single vector per item instead (see {@link itemVector}).
 */
async function resolvePassages(
  context: StoreContext,
  op: ParsedPut,
  value: Record<string, JsonValue>,
): Promise<number[][] | undefined> {
  if (op.index === false) return undefined;
  return embedPassages(context, value, op.index);
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
  const embedding = await itemVector(context, op);
  const embeddings = context.vectorBackend ? undefined : await resolvePassages(context, op, value);
  const ttlTimestamp = context.ttl ? calculateTtlTimestamp(context.ttl) : undefined;
  const record = await buildStoreRow(context, { namespace, key }, value, {
    createdAt: existing.createdAt ?? timestamp,
    updatedAt: timestamp,
    embeddings,
    ttlTimestamp,
    rev: randomUUID(),
  });
  await persistRow(context, record, existing);
  await syncItemVector(context, op.address, embedding);
}
