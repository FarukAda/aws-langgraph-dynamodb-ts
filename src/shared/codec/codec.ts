import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { ErrorCode } from '../errors/error-code';
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

/**
 * Fetch a descriptor's bytes — an S3 download when offloaded — and undo
 * compression. Infrastructure only, no deserialization: a caller that needs to
 * tell a transport or permission failure from bad data does this step and
 * `loadsTyped` separately (see `history/actions/get-messages.ts`).
 */
export async function readPayloadBytes(
  descriptor: PayloadDescriptor,
  deps: CodecDeps,
): Promise<Uint8Array> {
  const raw =
    descriptor.location === PayloadLocation.S3
      ? await requireOffloader(deps).download(descriptor.s3Key)
      : descriptor.bytes;
  return decompress(raw, descriptor.compressed, deps.compression?.maxDecompressedBytes);
}

/** Decode a {@link PayloadDescriptor} produced by {@link encodePayload}. */
export async function decodePayload<T>(descriptor: PayloadDescriptor, deps: CodecDeps): Promise<T> {
  return deps.serde.loadsTyped(descriptor.serdeType, await readPayloadBytes(descriptor, deps));
}

/**
 * True when an offloaded object no longer exists — a lifecycle sweep removed
 * it, or a competing overwrite deleted it between a row read and the download.
 */
export function isMissingObjectError(error: Error): boolean {
  const coded = error as { code?: string; cause?: { name?: string } };
  return coded.code === ErrorCode.S3_OFFLOAD_FAILED && coded.cause?.name === 'NoSuchKey';
}

/**
 * True when a payload can never be read again — its object is gone or it
 * trips the decompression guard — as opposed to a failure that may succeed on
 * retry or after a configuration fix (throttling, network, permissions).
 */
export function isPermanentPayloadLoss(error: Error): boolean {
  const coded = error as { code?: string };
  return coded.code === ErrorCode.COMPRESSION_LIMIT || isMissingObjectError(error);
}
