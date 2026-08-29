import { PayloadLocation, type PayloadDescriptor } from '../../shared/codec/codec';
import type { ChatMessageItem } from '../types';

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
 * Conservatively estimate a message item's stored size, so chunks can stay under
 * the DynamoDB transaction byte limit. The overhead allowance keeps the estimate
 * on the safe side of the real marshalled size.
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
 * Split message items into transaction-sized chunks bounded by both the item
 * count and the aggregate byte budget. A single item larger than the budget is
 * placed alone rather than dropped.
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
