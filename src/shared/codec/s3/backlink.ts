import { encodeKeyPart } from './key-scope';

/** The DynamoDB key an offloaded object belongs to. */
export interface BacklinkRow {
  pk: string;
  sk: string;
}

/**
 * Metadata names carrying the backlink. S3 lower-cases user-metadata keys, so
 * these are already lower-case; the `-b64` suffix states the encoding, because
 * a sweeper has to decode them to query DynamoDB.
 */
const PK_FIELD = 'dynamodb-pk-b64';
const SK_FIELD = 'dynamodb-sk-b64';

/**
 * The S3 user metadata linking an object back to the DynamoDB row that points
 * at it — the maintenance aid AWS names for this layout: "Store the primary key
 * value of the item as Amazon S3 metadata of the object" (*Best practices for
 * storing large items and attributes in DynamoDB*). Nothing in this package
 * reads it; it lets an out-of-band sweeper ask DynamoDB whether an object's
 * parent row still exists without parsing object keys.
 *
 * Both values are base64url-encoded. A `thread_id` or a store key may hold any
 * well-formed UTF-16 text, while S3 metadata travels in HTTP headers and the
 * User Guide asks for US-ASCII there; encoding unconditionally keeps every
 * value header-safe and keeps the decoding rule single, which a conditional
 * encoding would not.
 *
 * The pair fits S3's 2 KB metadata budget by construction, not by luck: the
 * same identifiers are already base64url-encoded into the object key, which
 * `buildS3Key` caps at 1024 bytes, so anything that produces a usable key
 * leaves these values far below the budget. `backlink.test.ts` pins that.
 *
 * Accepts: `row` — the DynamoDB key of the row that will point at the object.
 *
 * Returns: the two metadata fields, both base64url.
 *
 * Throws: nothing.
 */
export function backlinkMetadata(row: BacklinkRow): Record<string, string> {
  return { [PK_FIELD]: encodeKeyPart(row.pk), [SK_FIELD]: encodeKeyPart(row.sk) };
}

/**
 * The total UTF-8 bytes `metadata` costs against S3's 2 KB user-metadata cap.
 *
 * Accepts: any metadata map. Names and values both count, which is how S3
 * measures it.
 *
 * Returns: the byte total.
 *
 * Throws: nothing.
 */
export function metadataBytes(metadata: Record<string, string>): number {
  return Object.entries(metadata).reduce(
    (total, [name, value]) =>
      total + Buffer.byteLength(name, 'utf8') + Buffer.byteLength(value, 'utf8'),
    0,
  );
}
