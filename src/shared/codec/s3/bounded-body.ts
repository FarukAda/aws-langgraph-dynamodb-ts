import { DynamoDBLangGraphError } from '../../errors/base-error';
import { ErrorCode } from '../../errors/error-code';
import { truncateForLog } from '../../logging/truncate';

/** The part of an S3 `GetObject` body this module relies on. */
export interface S3Body {
  transformToByteArray(): Promise<Uint8Array>;
}

/** A body that can also be consumed chunk by chunk (Node's `IncomingMessage`). */
interface StreamingBody {
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  destroy?: () => void;
}

/**
 * The typed error for an object over the download cap.
 *
 * Accepts: `bytes` — what the object declared or what had been read when the
 * cap was passed; the message says which is not distinguished, because either
 * way the download stops.
 *
 * Returns: the error, coded `S3_OFFLOAD_FAILED` and carrying the key. The
 * message names the key bounded by {@link truncateForLog}, since it came off
 * a row; `context.key` carries it whole, because that is the field a caller
 * reads and it is one value per failed download rather than one per row.
 *
 * Throws: nothing — it builds the error, the caller throws it.
 */
export function oversizedObjectError(
  key: string,
  bytes: number,
  maxBytes: number,
): DynamoDBLangGraphError {
  return new DynamoDBLangGraphError(
    `S3 object ${truncateForLog(key)} exceeds the ${maxBytes}-byte maxDownloadBytes cap ` +
      `(${bytes} bytes declared or read)`,
    ErrorCode.S3_OFFLOAD_FAILED,
    { operation: 'download', key },
  );
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/**
 * The bytes of an S3 body, refused once they pass `maxBytes`.
 *
 * Accepts: `body` — a streaming body (Node's `IncomingMessage`, which the SDK
 * returns) is consumed chunk by chunk; a body offering only
 * `transformToByteArray()` is read whole and then checked. `key` — named in the
 * error. `maxBytes` — the cap; `0` admits only an empty body.
 *
 * Returns: the buffered bytes.
 *
 * Throws: `S3_OFFLOAD_FAILED` naming the key once the total passes `maxBytes`.
 * A streaming body is destroyed at that point, so the rest is never fetched.
 *
 * Guarantees: for a streaming body, peak memory is `maxBytes` plus the one
 * chunk that crossed it — the chunks already held never exceed the cap. For a
 * body without a stream the SDK has already buffered it, so the check bounds
 * what is *returned*, not what was read.
 */
export async function readBodyBounded(
  body: S3Body,
  key: string,
  maxBytes: number,
): Promise<Uint8Array> {
  const streaming = body as S3Body & StreamingBody;
  const iterate = streaming[Symbol.asyncIterator];
  if (typeof iterate !== 'function') {
    const whole = new Uint8Array(await body.transformToByteArray());
    if (whole.length > maxBytes) throw oversizedObjectError(key, whole.length, maxBytes);
    return whole;
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for await (const chunk of { [Symbol.asyncIterator]: iterate.bind(streaming) }) {
    total += chunk.length;
    if (total > maxBytes) {
      streaming.destroy?.();
      throw oversizedObjectError(key, total, maxBytes);
    }
    chunks.push(chunk);
  }
  return concat(chunks, total);
}
