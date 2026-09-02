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

/** Refuse a descriptor this version cannot read: a newer schema, or an unknown location. */
function assertReadableDescriptor(descriptor: PayloadDescriptor): void {
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

/** Decode a {@link PayloadDescriptor} produced by `encodePayload`; see {@link readPayloadBytes} for `scope`. */
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
