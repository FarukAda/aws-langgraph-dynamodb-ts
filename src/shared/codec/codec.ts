import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { MAX_INLINE_PAYLOAD_BYTES } from '../constants';
import { ValidationError } from '../errors/errors';
import { CompressionConfig, CompressionResult, compress, decompress } from './compression';
import type { S3Offloader } from './s3/offloader';

/** Where an encoded payload lives. */
export enum PayloadLocation {
  INLINE = 'INLINE',
  S3 = 'S3',
}

/** A payload stored inline as bytes in the DynamoDB item. */
interface InlinePayloadDescriptor {
  location: PayloadLocation.INLINE;
  serdeType: string;
  compressed: boolean;
  bytes: Uint8Array;
}

/** A payload offloaded to S3, referenced by key. */
interface S3PayloadDescriptor {
  location: PayloadLocation.S3;
  serdeType: string;
  compressed: boolean;
  s3Key: string;
}

/** The result of encoding a payload. */
export type PayloadDescriptor = InlinePayloadDescriptor | S3PayloadDescriptor;

/** Collaborators for the codec. */
export interface CodecDeps {
  serde: SerializerProtocol;
  compression?: CompressionConfig;
  offloader?: S3Offloader;
}

/** Options controlling where an offloaded payload's S3 key is built from. */
export interface EncodeOptions {
  keyParts: readonly string[];
}

function requireOffloader(deps: CodecDeps): S3Offloader {
  if (!deps.offloader) {
    throw new ValidationError(
      "this row's payload is offloaded to S3 but the adapter has no `s3` configuration; " +
        'configure the bucket the writer used',
      's3',
    );
  }
  return deps.offloader;
}

/**
 * Reject bytes that cannot be stored inline. Without an offloader the only
 * alternative is a raw `ValidationException` from DynamoDB after the network
 * round trip, which names neither the cause nor the remedy.
 */
function assertInlinePayloadFits(bytes: Uint8Array, deps: CodecDeps): void {
  if (bytes.length <= MAX_INLINE_PAYLOAD_BYTES) return;
  const hint = deps.compression?.enabled
    ? ''
    : ', or enable compression if the data compresses well';
  throw new ValidationError(
    `payload of ${bytes.length} bytes exceeds the ${MAX_INLINE_PAYLOAD_BYTES}-byte inline limit ` +
      `(DynamoDB items are capped at 400 KB); configure s3 offloading${hint}`,
    'payload',
  );
}

/**
 * Encode `value`: serialize via serde, compress (if configured), then offload
 * to S3 when the compressed bytes exceed the offloader's threshold. Returns a
 * descriptor recording how to read it back. Without an offloader, bytes that
 * cannot fit a DynamoDB item are rejected here (see
 * {@link assertInlinePayloadFits}).
 */
export async function encodePayload<T>(
  value: T,
  deps: CodecDeps,
  options: EncodeOptions,
): Promise<PayloadDescriptor> {
  const [serdeType, raw] = await deps.serde.dumpsTyped(value);
  const { bytes, compressed }: CompressionResult = deps.compression
    ? await compress(raw, deps.compression)
    : { bytes: raw, compressed: false };
  if (deps.offloader && deps.offloader.shouldOffload(bytes)) {
    const s3Key = deps.offloader.buildKey(options.keyParts);
    await deps.offloader.upload(s3Key, bytes);
    return { location: PayloadLocation.S3, serdeType, compressed, s3Key };
  }
  if (!deps.offloader) assertInlinePayloadFits(bytes, deps);
  return { location: PayloadLocation.INLINE, serdeType, compressed, bytes };
}

/**
 * Fetch a descriptor's bytes — an S3 download when offloaded — and undo
 * compression. Infrastructure only, no deserialization: a caller that needs to
 * tell a transport or permission failure from bad data does this step and
 * `loadsTyped` separately (see `history/actions/get-messages.ts`).
 *
 * `scope` is the row's own leading key parts (`[threadId]`, `[...namespace,
 * key]`, `[sessionId]`): an offloaded key is downloaded only when it lies under
 * the path those parts produce, so a row can never point this adapter at an
 * object it does not own.
 */
export async function readPayloadBytes(
  descriptor: PayloadDescriptor,
  deps: CodecDeps,
  scope: readonly string[],
): Promise<Uint8Array> {
  let raw: Uint8Array;
  if (descriptor.location === PayloadLocation.S3) {
    const offloader = requireOffloader(deps);
    offloader.assertOwnedKey(descriptor.s3Key, scope);
    raw = await offloader.download(descriptor.s3Key);
  } else {
    raw = descriptor.bytes;
  }
  return decompress(raw, descriptor.compressed, deps.compression?.maxDecompressedBytes);
}

/** Decode a {@link PayloadDescriptor} produced by {@link encodePayload}; see {@link readPayloadBytes} for `scope`. */
export async function decodePayload<T>(
  descriptor: PayloadDescriptor,
  deps: CodecDeps,
  scope: readonly string[],
): Promise<T> {
  return deps.serde.loadsTyped(
    descriptor.serdeType,
    await readPayloadBytes(descriptor, deps, scope),
  );
}
