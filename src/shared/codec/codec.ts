import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { ValidationError } from '../errors/errors';
import { CompressionConfig, decompress } from './compression';
import type { S3Offloader } from './s3/offloader';

/** Where an encoded payload lives. */
export enum PayloadLocation {
  INLINE = 'INLINE',
  S3 = 'S3',
}

/**
 * Version of the persisted descriptor shape. Absent on rows written before it
 * existed, which read as version 1; a higher value marks a row written by a
 * newer library and is refused rather than misread.
 */
export const DESCRIPTOR_SCHEMA_VERSION = 1;

/** Fields every descriptor carries, whatever its location. */
interface DescriptorBase {
  schemaVersion?: number;
  serdeType: string;
  compressed: boolean;
}

/** A payload stored inline as bytes in the DynamoDB item. */
interface InlinePayloadDescriptor extends DescriptorBase {
  location: PayloadLocation.INLINE;
  bytes: Uint8Array;
}

/** A payload offloaded to S3, referenced by key. */
interface S3PayloadDescriptor extends DescriptorBase {
  location: PayloadLocation.S3;
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
 * Refuse a descriptor this version cannot read: one that is not an object at
 * all, one whose schema is newer, or one whose location is unknown. A row can
 * hold anything its writer stored, and reading `.schemaVersion` off `null`
 * raised a raw `TypeError` out of a public method.
 */
function assertReadableDescriptor(descriptor: PayloadDescriptor): void {
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new ValidationError(
      `payload descriptor is ${descriptor === null ? 'null' : typeof descriptor}, not a descriptor ` +
        'this library wrote',
      'descriptor',
    );
  }
  const version = descriptor.schemaVersion ?? DESCRIPTOR_SCHEMA_VERSION;
  if (version > DESCRIPTOR_SCHEMA_VERSION) {
    throw new ValidationError(
      `payload descriptor schemaVersion ${version} was written by a newer version of this ` +
        'library; upgrade to read it',
      'descriptor',
    );
  }
  const locations: string[] = Object.values(PayloadLocation);
  if (!locations.includes(descriptor.location)) {
    throw new ValidationError(
      `payload descriptor has an unknown location ${JSON.stringify(descriptor.location)}`,
      'descriptor',
    );
  }
}

/**
 * The payload bytes a descriptor stands for: downloaded when offloaded, then
 * decompressed. Infrastructure only, no deserialization — a caller that needs
 * to tell a transport or permission failure from bad data does this step and
 * `loadsTyped` separately (see `src/history/actions/get-messages.ts`).
 *
 * Accepts: `descriptor` — as written by {@link encodePayload}; a
 * `schemaVersion` above this release's, or a `location` it does not know, is
 * refused rather than guessed at. `deps.offloader` — required only for an `S3`
 * descriptor. `scope` — the row's own leading key parts (`[threadId]`,
 * `[...namespace, key]`, `[sessionId]`); `[]` degrades the check to the
 * configured prefix.
 *
 * Returns: the decoded bytes.
 *
 * Throws: ValidationError naming `descriptor` for an unreadable shape and `s3`
 * for an offloaded row with no offloader configured; ValidationError naming
 * `s3Key` when the key lies outside `scope`; `S3_OFFLOAD_FAILED` from the
 * download; `COMPRESSION_LIMIT` or `PAYLOAD_CORRUPT` from decompression.
 *
 * Guarantees: an offloaded object is downloaded only when its key lies under
 * the path `scope` produces, so a row can never point this adapter at an
 * object it does not own.
 */
export async function readPayloadBytes(
  descriptor: PayloadDescriptor,
  deps: CodecDeps,
  scope: readonly string[],
): Promise<Uint8Array> {
  assertReadableDescriptor(descriptor);
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

/**
 * The value a descriptor stands for: {@link readPayloadBytes} followed by the
 * serde's `loadsTyped`.
 *
 * Accepts: as {@link readPayloadBytes}; `scope` has the same meaning.
 *
 * Returns: whatever the serde reconstructs, typed as the caller declares.
 *
 * Throws: everything {@link readPayloadBytes} throws, plus whatever
 * `loadsTyped` raises for bytes it cannot parse — `PAYLOAD_CORRUPT` from this
 * package's own serde.
 */
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
