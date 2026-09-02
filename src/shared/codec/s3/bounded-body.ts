import { DynamoDBLangGraphError } from '../../errors/base-error';
import { ErrorCode } from '../../errors/error-code';

/** The part of an S3 `GetObject` body this module relies on. */
export interface S3Body {
  transformToByteArray(): Promise<Uint8Array>;
}

/** A body that can also be consumed chunk by chunk (Node's `IncomingMessage`). */
interface StreamingBody {
  [Symbol.asyncIterator]?: () => AsyncIterator<Uint8Array>;
  destroy?: () => void;
}

/** The typed error for an object over the download cap. */
export function oversizedObjectError(
  key: string,
  bytes: number,
  maxBytes: number,
): DynamoDBLangGraphError {
  return new DynamoDBLangGraphError(
    `S3 object ${key} exceeds the ${maxBytes}-byte maxDownloadBytes cap ` +
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
 * Buffer an S3 body without ever holding more than `maxBytes` of it. A
 * streaming body is consumed chunk by chunk and abandoned the moment the
 * running total passes the cap; a body that only offers
 * `transformToByteArray()` is read whole and then checked.
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
