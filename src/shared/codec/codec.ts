import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { CompressionConfig, CompressionResult, compress, decompress } from './compression';
import type { S3Offloader } from './s3/offloader';

/** Where an encoded payload lives. */
export enum PayloadLocation {
  INLINE = 'INLINE',
  S3 = 'S3',
}

/** A payload stored inline as bytes in the DynamoDB item. */
export interface InlinePayloadDescriptor {
  location: PayloadLocation.INLINE;
  serdeType: string;
  compressed: boolean;
  bytes: Uint8Array;
}

/** A payload offloaded to S3, referenced by key. */
export interface S3PayloadDescriptor {
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
    throw new Error('Cannot decode an S3 payload without an offloader');
  }
  return deps.offloader;
}

/**
 * Encode `value`: serialize via serde, compress (if configured), then offload
 * to S3 when the compressed bytes exceed the offloader's threshold. Returns a
 * descriptor recording how to read it back.
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
  return { location: PayloadLocation.INLINE, serdeType, compressed, bytes };
}

/** Decode a {@link PayloadDescriptor} produced by {@link encodePayload}. */
export async function decodePayload<T>(descriptor: PayloadDescriptor, deps: CodecDeps): Promise<T> {
  const raw =
    descriptor.location === PayloadLocation.S3
      ? await requireOffloader(deps).download(descriptor.s3Key)
      : descriptor.bytes;
  const bytes = await decompress(
    raw,
    descriptor.compressed,
    deps.compression?.maxDecompressedBytes,
  );
  return deps.serde.loadsTyped(descriptor.serdeType, bytes);
}
