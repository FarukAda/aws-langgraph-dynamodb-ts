/**
 * Hides how a value becomes a stored payload and back.
 *
 * A value is serialized by the configured serde, gzipped when that pays, and
 * kept inline in its row or offloaded to S3 under a key its row can be traced
 * from, behind a versioned descriptor the row stores. Reading reverses that,
 * and a failure that means the payload can never be read again — a corrupt
 * body, a missing object, a descriptor no reader understands — is told apart
 * here from one a retry might cure.
 */

import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import {
  DynamoDBLangGraphError,
  hasErrorCode,
  isDynamoDBLangGraphError,
  toError,
} from '../errors/base-error';
import { isMissingObject } from '../errors/classify';
import { ErrorCode } from '../errors/error-code';
import { validationError } from '../errors/errors';
import { truncateForLog } from '../logging/truncate';
import {
  type CompressionConfig,
  type CompressionResult,
  compress,
  decompress,
} from './compression';
import { bytesHoldDeclaredForm } from './json-serde';
import type { S3Offloader } from './s3/offloader';

/**
 * Largest serialized payload stored inline when no S3 offloader is configured:
 * DynamoDB's 400 KB item cap less 8 KB of headroom for the item's keys,
 * attribute names and descriptor fields. Exceeding it fails before the write
 * with a typed error instead of a raw `ValidationException` after it.
 */
export const MAX_INLINE_PAYLOAD_BYTES = 400 * 1024 - 8 * 1024;

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

/**
 * The codec collaborators an adapter context carries, with a call's signal.
 *
 * Accepts: `source` — the adapter's serde, compression and offloader.
 * `signal` — the call's cancellation, carried into the S3 request a payload
 * needs.
 *
 * Returns: the collaborators the codec takes.
 *
 * Throws: nothing.
 */
export function codecDepsOf(
  source: Pick<CodecDeps, 'serde' | 'compression' | 'offloader'>,
  signal?: AbortSignal,
): CodecDeps {
  return {
    serde: source.serde,
    compression: source.compression,
    offloader: source.offloader,
    signal,
  };
}

function configuredOffloader(deps: CodecDeps): S3Offloader {
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
    const offloader = configuredOffloader(deps);
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

/** The DynamoDB key of the row that will hold the descriptor being built. */
interface RowKey {
  pk: string;
  sk: string;
}

/** Options controlling where an offloaded payload's S3 key is built from. */
export interface EncodeOptions {
  /**
   * The identity of the row this payload belongs to, as the path segments
   * above {@link EncodeOptions.objectId}. A reader refuses an object that lies
   * outside the path its row's leading identifiers produce.
   */
  keyParts: readonly string[];
  /**
   * The id of the write this payload belongs to, and the key's last segment.
   * The caller draws a fresh UUID or ULID for each write — each store put, each
   * checkpoint put, each `putWrites` call, each history message — and passes the
   * same one for every payload of that write, whose `keyParts` already differ.
   * No other write uses that id, so no row another write commits names the
   * object.
   */
  objectId: string;
  /**
   * The row's DynamoDB key, stored on the object as the backlink AWS
   * recommends for exactly this layout: "Store the primary key value of the
   * item as Amazon S3 metadata of the object" (*Best practices for storing
   * large items and attributes in DynamoDB*). Nothing in this package reads it
   * back; it exists so an out-of-band sweeper can ask DynamoDB whether an
   * object's parent row still exists without parsing object keys.
   */
  row: RowKey;
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
  throw validationError(
    `payload of ${bytes.length} bytes exceeds the ${MAX_INLINE_PAYLOAD_BYTES}-byte inline limit ` +
      `(DynamoDB items are capped at 400 KB); configure s3 offloading${hint}`,
    'payload',
  );
}

/**
 * Reject a value the serde turned into no bytes at all. Zero bytes is not a
 * small payload: it is not a document in any format a reader can parse, so the
 * row is written happily and every later read of it fails. Checked before
 * compression, so an inline and an offloaded payload are refused identically
 * and nothing is uploaded for a payload no reader could ever use.
 *
 * What reaches it under the default `JsonPlusSerializer` is a value that is
 * *itself* a function or a symbol. A bare `undefined` is not one of them — it
 * encodes to a 27-byte marker — and neither is a function or symbol nested in
 * an object or an array, which is dropped from the document instead of
 * emptying it, silently and out of this check's sight.
 *
 * The rule binds every serde, not only the defaults. A `serde` whose encoding
 * of some legitimate value is genuinely empty — a message format whose empty
 * message is zero bytes — cannot store that value through this package, and
 * would have to give it a byte of its own.
 */
function assertSerialisedToBytes(raw: Uint8Array): void {
  if (raw.length > 0) return;
  throw validationError(
    'value serialises to zero bytes, which no reader can parse back: a function, a symbol ' +
      'or any value the configured serde drops encodes to nothing. Store a value the serde ' +
      'can represent, or configure one that refuses it.',
    'value',
  );
}

/**
 * The descriptor recording how to read `value` back: serialized, compressed if
 * configured, and offloaded to S3 if large enough.
 *
 * Accepts: `value` — anything the serde can represent as at least one byte;
 * what it cannot represent is the serde's own error, and what it represents as
 * nothing is refused here (see {@link assertSerialisedToBytes}), whichever
 * serde is configured. `deps.compression` — absent or `enabled: false` stores the
 * serialized bytes as they are. `deps.offloader` — absent stores every payload
 * inline. `deps.signal` — cancels the upload of an offloaded payload; an
 * inline one is never sent anywhere and ignores it. `options` — the row's
 * identity, the write's object id and the row's DynamoDB key (see
 * {@link EncodeOptions}).
 *
 * Returns: an `S3` descriptor when an offloader is configured and
 * `shouldOffload` accepts the compressed size, otherwise an `INLINE`
 * descriptor carrying the bytes. Both record `serdeType` and `compressed`, so
 * neither is ever inferred from the bytes on read.
 *
 * Throws: whatever `serde.dumpsTyped` throws; `ABORTED` when the signal
 * fires during the upload; `S3_OFFLOAD_FAILED` from the upload; and two
 * distinguishable `VALIDATION` errors. One names `payload` — the bytes are too
 * large to store inline — and is raised only when there is **no** offloader
 * and they exceed `MAX_INLINE_PAYLOAD_BYTES`. With an offloader that
 * cell cannot arise: `s3.thresholdBytes` is itself capped at that limit
 * (`src/shared/validation/options.ts`, `assertS3`), so bytes too large
 * to store inline are always at or above the threshold and offload instead.
 * The other names `value` — it serialises to nothing (see
 * {@link assertSerialisedToBytes}) — and is raised for an offloaded payload
 * and an inline one alike, before either is stored.
 */
export async function encodePayload<T>(
  value: T,
  deps: CodecDeps,
  options: EncodeOptions,
): Promise<PayloadDescriptor> {
  const [serdeType, raw] = await deps.serde.dumpsTyped(value);
  assertSerialisedToBytes(raw);
  const { bytes, compressed }: CompressionResult = deps.compression
    ? await compress(raw, deps.compression)
    : { bytes: raw, compressed: false };
  /**
   * `writeId` is set here rather than at each call site so both descriptor
   * kinds and every adapter inherit one identity from one statement. It does
   * not raise `DESCRIPTOR_SCHEMA_VERSION`: the version is refused by a reader
   * that is older than it, and this field is additive and ignorable, so
   * announcing it would cost readability of these rows for nothing.
   */
  const base = {
    schemaVersion: DESCRIPTOR_SCHEMA_VERSION,
    serdeType,
    compressed,
    writeId: options.objectId,
  };
  if (deps.offloader && deps.offloader.shouldOffload(bytes)) {
    const s3Key = deps.offloader.buildKey(options.keyParts, options.objectId);
    await deps.offloader.upload(s3Key, bytes, options.row, deps.signal);
    return { ...base, location: PayloadLocation.S3, s3Key };
  }
  if (!deps.offloader) assertInlinePayloadFits(bytes, deps);
  return { ...base, location: PayloadLocation.INLINE, bytes };
}

/**
 * The part of a descriptor cleanup needs: where the payload lives and, for S3,
 * its key. A full `PayloadDescriptor` satisfies it, and so does the projection
 * a pre-write read returns without the inline bytes.
 */
export interface DescriptorRef {
  location: PayloadLocation;
  s3Key?: string;
}

/**
 * The S3 keys of whichever descriptors are offloaded.
 *
 * Accepts: `descriptors` — any mix of inline and offloaded, including a
 * projection that carries only `location` and `s3Key`, and including none. An
 * offloaded descriptor missing its key is skipped rather than deleted blindly,
 * and so is an entry that is not a descriptor at all: several callers read
 * these straight off a row, and a row this library did not write can hold
 * `null` where the descriptor belongs, or omit the attribute entirely. Widening
 * the parameter rather than making each caller filter is what lets the `Throws`
 * clause below hold for every caller instead of only the careful ones.
 *
 * Returns: the keys, in the order given; an inline payload contributes none,
 * and neither does an absent one.
 *
 * Throws: nothing — this feeds cleanup, which must not fail the operation it
 * follows.
 */
export function collectS3Keys(
  descriptors: readonly (DescriptorRef | null | undefined)[],
): string[] {
  const keys: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor?.location === PayloadLocation.S3 && descriptor.s3Key !== undefined) {
      keys.push(descriptor.s3Key);
    }
  }
  return keys;
}

/**
 * True when an offloaded object no longer exists.
 *
 * Accepts: `error` — any error; only `S3_OFFLOAD_FAILED` carrying a `NoSuchKey`
 * cause matches. An error with no `cause`, or one whose cause names another
 * S3 failure, is not a missing object. Anything else a `throw` can produce —
 * `null`, `undefined`, a primitive — carries no code and is not one either.
 *
 * Returns: whether the object is gone — a lifecycle sweep removed it, or a
 * competing overwrite deleted it between a row read and the download.
 *
 * Throws: **nothing**, for any value. A caught value that cannot carry a
 * property answers `false`, as `isDynamoDBLangGraphError` does, rather than
 * raising a `TypeError` inside the `catch` that is reporting the download
 * failure this test exists to classify.
 */
export function isMissingObjectError(error: Error): boolean {
  return (
    hasErrorCode(error, ErrorCode.S3_OFFLOAD_FAILED) &&
    error.cause !== undefined &&
    isMissingObject(error.cause as Error)
  );
}

/**
 * True when a row's payload descriptor is not one *any* reader could make sense
 * of: it is absent, it is not an object, or it names a location no release of
 * this library ever wrote at the schema it declares. The row condemns its own
 * payload — no retry and no configuration change makes those bytes readable,
 * and no other reader would fare better.
 *
 * Two refusals from the same guard are deliberately *not* matched here, both
 * because the sentence above would be false of them. A `VALIDATION` error naming
 * `s3Key` says the reader may not follow the key, not that the payload is
 * unreadable (see `assertKeyInScope`). A `FORMAT_UNSUPPORTED` naming
 * `schemaVersion` says the payload was written by a newer release — which reads
 * it perfectly — so it is the one descriptor refusal a newer reader *does* fare
 * better on, and writing it off silently dropped turns during a rollback or a
 * canary (see `assertReadableDescriptor`).
 */
function isUnreadableDescriptor(error: Error): boolean {
  return hasErrorCode(error, ErrorCode.VALIDATION) && error.context.field === 'descriptor';
}

/**
 * True when a payload can never be read again, as opposed to a failure that may
 * succeed on retry or after a configuration fix (throttling, network,
 * permissions).
 *
 * Accepts: `error` — any error. Permanent are: its object is gone
 * ({@link isMissingObjectError}), its bytes are not the form the row declares
 * (`PAYLOAD_CORRUPT`), it trips the decompression guard (`COMPRESSION_LIMIT`),
 * or the row's own descriptor is unreadable ({@link isUnreadableDescriptor}).
 * Everything else is false, including an error that carries no code at all, and
 * including three refusals that look like loss and are not. The `s3Key` scope
 * refusal: a row pointing outside its own path is a configuration or tenancy
 * fault to report, not a payload to write off. The `serde` refusal, on the same
 * reasoning: the bytes are checked against the form the row declares before
 * that code is chosen, so reaching it means they are undamaged and a serializer
 * declining to reconstruct the class they name says what *this* reader may do,
 * not what the payload is (see `loadPayloadValue`). And `FORMAT_UNSUPPORTED`,
 * on a row or on a payload: newer is not lost.
 *
 * Returns: whether a caller should report rather than retry.
 *
 * Throws: **nothing**, for any value a `throw` can produce. One that cannot
 * carry a code is not permanent loss, which is the same answer an uncoded
 * `Error` gets.
 */
export function isPermanentPayloadLoss(error: Error): boolean {
  return (
    hasErrorCode(error, ErrorCode.COMPRESSION_LIMIT) ||
    hasErrorCode(error, ErrorCode.PAYLOAD_CORRUPT) ||
    isMissingObjectError(error) ||
    isUnreadableDescriptor(error)
  );
}
