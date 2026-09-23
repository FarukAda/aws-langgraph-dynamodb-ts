import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { DynamoDBLangGraphError, isDynamoDBLangGraphError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';
import { validationError } from '../errors/errors';
import { toError } from '../errors/to-error';
import { truncateForLog } from '../logging/truncate';
import { CompressionConfig, decompress } from './compression';
import { bytesHoldDeclaredForm } from './declared-form';
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
  /**
   * The id of the write that produced this descriptor — the `objectId` its
   * encode was given, and the identity a delete pins on to tell the row it
   * observed from one another write replaced since. Optional because a row
   * written before the field existed carries none, and a row observed without
   * one is deleted unconditionally rather than pinned on nothing.
   */
  writeId?: string;
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
  /**
   * The caller's cancellation, carried into the S3 upload or download a
   * payload costs. It belongs here rather than on a parameter of its own for
   * the same reason `RetryOptions.signal` does: the deps object is built per
   * call at every use site, so "these options carry a signal" is already how
   * this package decides what a cancel may interrupt — and a path that must
   * not be interrupted keeps building its deps without one.
   */
  signal?: AbortSignal;
}

function requireOffloader(deps: CodecDeps): S3Offloader {
  if (!deps.offloader) {
    throw validationError(
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
 *
 * The newer schema is the one of the three that is **not** the payload's own
 * fault, and it is coded apart from the other two for that reason. A descriptor
 * that is not an object, and one naming a location no release ever wrote at
 * this schema, condemn themselves: no upgrade and no configuration makes those
 * bytes readable, so a reader may write them off. A forward `schemaVersion`
 * says the opposite — the payload is intact and the release that wrote it reads
 * it perfectly — so it is `FORMAT_UNSUPPORTED`, exactly as a forward `v` on the
 * row around it is, naming the attribute that carried the version. Sharing the
 * `descriptor` field put it in the permanent-loss bucket, where history's
 * default `skip` silently dropped during a rollback or a canary the very turns
 * the store and the saver refused to serve.
 *
 * Both of the values these messages quote come off the row, so both go through
 * `truncateForLog`. The version is declared a number and the comparison
 * coerces, so a row carrying a thousand digits as a string passes it and
 * reaches the message; the location is quoted as JSON, which a row can make
 * any length at all.
 */
function assertReadableDescriptor(descriptor: PayloadDescriptor): void {
  if (descriptor === null || typeof descriptor !== 'object') {
    throw validationError(
      `payload descriptor is ${descriptor === null ? 'null' : typeof descriptor}, not a descriptor ` +
        'this library wrote',
      'descriptor',
    );
  }
  const version = descriptor.schemaVersion ?? DESCRIPTOR_SCHEMA_VERSION;
  if (version > DESCRIPTOR_SCHEMA_VERSION) {
    /** Declared a number, read off a row, and the comparison coerces a string. */
    const written = truncateForLog(String(version));
    throw new DynamoDBLangGraphError(
      `this payload was written in descriptor schema version ${written}; this version of the ` +
        `library reads up to ${DESCRIPTOR_SCHEMA_VERSION} — upgrade to read it`,
      ErrorCode.FORMAT_UNSUPPORTED,
      { field: 'schemaVersion' },
    );
  }
  const locations: string[] = Object.values(PayloadLocation);
  if (!locations.includes(descriptor.location)) {
    /** The location is whatever the row holds, and the row is what this refuses. */
    const location = truncateForLog(String(JSON.stringify(descriptor.location)));
    throw validationError(`payload descriptor has an unknown location ${location}`, 'descriptor');
  }
}

/**
 * The payload bytes a descriptor stands for: downloaded when offloaded, then
 * decompressed. Infrastructure only, no deserialization — a caller that needs
 * to tell a transport or permission failure from bad data does this step and
 * {@link loadPayloadValue} separately (see
 * `src/history/actions/get-messages.ts`).
 *
 * Accepts: `descriptor` — as written by {@link encodePayload}; a
 * `schemaVersion` above this release's, or a `location` it does not know, is
 * refused rather than guessed at. `deps.offloader` — required only for an `S3`
 * descriptor. `scope` — the row's own leading key parts (`[threadId]`,
 * `[...namespace, key]`, `[sessionId]`); `[]` degrades the check to the
 * configured prefix. `deps.signal` — cancels the download of an offloaded
 * payload, request and all; an inline one reads no bytes and ignores it.
 *
 * Returns: the decoded bytes.
 *
 * Throws: `VALIDATION` naming `descriptor` for a shape no reader could
 * make sense of and `s3` for an offloaded row with no offloader configured;
 * `FORMAT_UNSUPPORTED` naming `schemaVersion` for a payload a newer release
 * wrote, which a newer reader reads fine; `VALIDATION` naming `s3Key` when
 * the key lies outside `scope`; `ABORTED` when the signal fires during the
 * download; `S3_OFFLOAD_FAILED` from the download; `COMPRESSION_LIMIT` or
 * `PAYLOAD_CORRUPT` from decompression.
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
    raw = await offloader.download(descriptor.s3Key, deps.signal);
  } else {
    raw = descriptor.bytes;
  }
  return decompress(raw, descriptor.compressed, deps.compression?.maxDecompressedBytes);
}

/**
 * The value stored bytes hold, with a serde that refuses them branded rather
 * than left bare.
 *
 * Accepts: `serdeType` — the row's own, handed to the serde unchanged, and the
 * declared form {@link bytesHoldDeclaredForm} checks the bytes against.
 * `bytes` — what {@link readPayloadBytes} returned. `deps.serde` — the
 * serializer the adapter was configured with, which may be the caller's.
 *
 * Returns: whatever the serde reconstructs, typed as the caller declares.
 *
 * Throws: the serde's own error whenever it is already one of this library's,
 * so `PAYLOAD_CORRUPT` from `JSON_SERDE` stays exactly what it was — as does
 * its refusal of a `serdeType` it has no grammar for, which it brands the same
 * `VALIDATION` naming `serde` that the classifier below reaches for on the
 * identical row under any other serde; `PAYLOAD_CORRUPT` when the bytes are no
 * longer the form the row declares, on whatever serde raised it; anything else
 * as a `VALIDATION` error naming `serde`, carrying the refusal as `cause`.
 *
 * Guarantees: no error leaves a decode unbranded, and which serde the adapter
 * was configured with never decides *which* brand. A rotted row read through
 * `JSON_SERDE` reported `PAYLOAD_CORRUPT` while the identical row read through
 * the checkpointer's own default reported the refusal below, so a caller
 * quarantining on `PAYLOAD_CORRUPT` never matched and `history.getMessages`
 * lost a whole conversation where it promises one dropped message. A row
 * declaring a form neither serde writes ran the same divergence the other way,
 * and reached further: `JSON_SERDE` ignored the declared type, so its own
 * `JSON.parse` failure arrived here already branded and the classifier was
 * never consulted. The serializer honours the declared form now, which is what
 * keeps this the one place the distinction is drawn.
 *
 * The refusal is what remains once the bytes are known to be intact: the
 * serializer would not reconstruct the value they name. A stored `lc`
 * constructor record naming a class outside LangChain's allow-list is refused
 * by `load()` with a plain `Error`, which a public boundary could only rebrand
 * as an `UNEXPECTED_ERROR` — reporting a row's own content to the caller as an AWS
 * failure. It is deliberately *not* classified as payload loss, for
 * `assertKeyInScope`'s reason rather than `PAYLOAD_CORRUPT`'s: the bytes are
 * undamaged and parse, and which classes revive is a property of **this**
 * reader — the serde it was given, and what that serde's allow-list carries —
 * not of the payload. A refusal that says only "this reader may not
 * reconstruct that" is a misconfigured serde or a planted row, both of which an
 * operator must see; writing it off would let `history.getMessages` answer with
 * a silently shorter conversation for the one row shape most worth noticing.
 */
export async function loadPayloadValue<T>(
  serdeType: string,
  bytes: Uint8Array,
  deps: CodecDeps,
): Promise<T> {
  try {
    return await deps.serde.loadsTyped(serdeType, bytes);
  } catch (error) {
    const refusal = toError(error as Error);
    if (isDynamoDBLangGraphError(refusal)) throw refusal;
    if (!bytesHoldDeclaredForm(serdeType, bytes)) {
      throw new DynamoDBLangGraphError(
        'the stored payload is no longer the form this row declares, so no serde could decode ' +
          'it; the refusal that proved it is attached as `cause`',
        ErrorCode.PAYLOAD_CORRUPT,
        {},
        refusal,
      );
    }
    throw validationError(
      'the configured serde refused the payload stored in this row: the bytes parse, but the ' +
        'serializer would not reconstruct the value they name — a stored `lc` constructor record ' +
        'naming a class outside its allow-list reads this way, as does a serde that did not ' +
        'write these bytes. The refusal itself is attached as `cause`',
      'serde',
      refusal,
    );
  }
}

/**
 * The value a descriptor stands for: {@link readPayloadBytes} followed by
 * {@link loadPayloadValue}.
 *
 * Accepts: as {@link readPayloadBytes}; `scope` has the same meaning.
 *
 * Returns: whatever the serde reconstructs, typed as the caller declares.
 *
 * Throws: everything {@link readPayloadBytes} throws, plus everything
 * {@link loadPayloadValue} throws for bytes the serde will not accept —
 * `PAYLOAD_CORRUPT` for bytes that are no longer the form the row declares,
 * whichever serde is configured, `VALIDATION` naming `serde` for a refusal
 * of bytes that are still intact.
 *
 * Guarantees: the bytes are read first, in a statement of their own. Passing
 * `descriptor.serdeType` and the awaited read as two arguments to one call read
 * the property *before* the guard ran, since arguments evaluate left to right —
 * so a row whose payload is `null` raised a bare `TypeError` carrying no code,
 * which a public boundary can only rebrand as an `UNEXPECTED_ERROR`. Every read
 * path now answers such a row with the `VALIDATION` error naming `descriptor` that
 * the history adapter, which reads its bytes separately, already produced.
 */
export async function decodePayload<T>(
  descriptor: PayloadDescriptor,
  deps: CodecDeps,
  scope: readonly string[],
): Promise<T> {
  const bytes = await readPayloadBytes(descriptor, deps, scope);
  return loadPayloadValue<T>(descriptor.serdeType, bytes, deps);
}
