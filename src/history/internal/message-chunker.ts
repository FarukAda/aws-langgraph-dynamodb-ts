import { PayloadLocation, type PayloadDescriptor } from '../../shared/codec/codec';
import type { ChatMessageItem } from './rows';

/**
 * Per-item allowance added to the measured field bytes to cover what the size
 * estimate does not count directly: DynamoDB attribute names, the document
 * marshalling envelope, and descriptor scaffolding. Deliberately generous so the
 * estimate stays at or above the real marshalled item size and chunks never
 * overshoot the transaction byte limit.
 */
const ITEM_OVERHEAD_BYTES = 256;

/**
 * Byte length of a string as DynamoDB stores it. `String.length` counts UTF-16
 * code units, which understates every non-ASCII character — the wrong
 * direction for an estimate documented to sit at or above the real size.
 */
function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function descriptorBytes(descriptor: PayloadDescriptor): number {
  const body =
    descriptor.location === PayloadLocation.INLINE
      ? descriptor.bytes.length
      : utf8Bytes(descriptor.s3Key);
  return body + utf8Bytes(descriptor.serdeType);
}

/**
 * Conservatively estimate a message item's stored size.
 *
 * Accepts: any message item, inline or offloaded — an offloaded one measures
 * its S3 key, since that is what the row actually carries.
 *
 * Returns: an estimate at or above the real marshalled size. Erring high is the
 * whole point: an underestimate builds a transaction DynamoDB refuses, and the
 * cost of erring high is one extra transaction.
 *
 * Throws: nothing.
 */
export function estimateItemBytes(item: ChatMessageItem): number {
  return (
    utf8Bytes(item.PK) +
    utf8Bytes(item.SK) +
    utf8Bytes(item.sessionId) +
    descriptorBytes(item.message) +
    ITEM_OVERHEAD_BYTES
  );
}

function shouldFlush(
  count: number,
  bytes: number,
  next: number,
  max: number,
  maxBytes: number,
): boolean {
  if (count === 0) return false;
  return count >= max || bytes + next > maxBytes;
}

/**
 * Split message items into transaction-sized chunks.
 *
 * Accepts: `items` — in order; empty yields no chunks, so an append of nothing
 * issues no write. `maxItems` and `maxBytes` — the transaction's two limits,
 * both binding.
 *
 * Returns: the chunks, in order, each within both limits — except that a single
 * item larger than `maxBytes` is placed alone rather than dropped: refusing it
 * here would lose a message that DynamoDB might still accept, and if it does
 * not, the transaction says so.
 *
 * Throws: nothing.
 *
 * Guarantees: order is preserved across chunks, so messages keep the order the
 * caller wrote them in, which is the order their ULIDs already encode.
 */
export function chunkBySize(
  items: ChatMessageItem[],
  maxItems: number,
  maxBytes: number,
): ChatMessageItem[][] {
  const chunks: ChatMessageItem[][] = [];
  let current: ChatMessageItem[] = [];
  let currentBytes = 0;
  for (const item of items) {
    const size = estimateItemBytes(item);
    if (shouldFlush(current.length, currentBytes, size, maxItems, maxBytes)) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(item);
    currentBytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}
