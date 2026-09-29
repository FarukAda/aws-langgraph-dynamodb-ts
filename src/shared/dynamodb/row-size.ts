/**
 * Hides how DynamoDB measures a row against its 400 KB item limit.
 *
 * DynamoDB does not measure a row by its JSON length: every attribute name
 * counts, a number costs a byte per two significant digits and one more,
 * binary counts its raw bytes, and a list or a map adds three bytes and one
 * per element. A write that would cross the limit is refused here, by those
 * rules, before anything is sent, so the caller learns which input made the
 * row too large instead of reading an `AWS_REJECTED` error after the work that
 * built the row — an embedding, an upload — was already done.
 */

import type { AttributeMap } from './client.js';

/** DynamoDB's cap on one item, 400 KB, in the binary kilobytes its documentation counts in. */
export const MAX_ROW_BYTES = 400 * 1024;

/** What a row's attribute can hold once the document client has marshalled it. */
type RowValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Uint8Array
  | RowValue[]
  | { [name: string]: RowValue };

/** The bytes one attribute name costs. */
function nameBytes(name: string): number {
  return Buffer.byteLength(name, 'utf8');
}

/**
 * A number's significant digits as the SDK sends it — `String(value)` — with
 * its sign, decimal point, exponent and leading and trailing zeros set aside,
 * as DynamoDB trims them.
 */
function significantDigits(value: number): number {
  const mantissa = String(Math.abs(value)).split(/e/i)[0].replace('.', '');
  const trimmed = mantissa.replace(/^0+/, '').replace(/0+$/, '');
  return Math.max(trimmed.length, 1);
}

/** The bytes one attribute value costs, by DynamoDB's own size rules. */
function valueBytes(value: RowValue): number {
  if (typeof value === 'string') return Buffer.byteLength(value, 'utf8');
  if (typeof value === 'number') return Math.ceil(significantDigits(value) / 2) + 1;
  if (typeof value === 'boolean' || value === null || value === undefined) return 1;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (Array.isArray(value)) {
    return value.reduce<number>((sum, element) => sum + valueBytes(element) + 1, 3);
  }
  return Object.entries(value).reduce(
    (sum, [name, element]) => sum + nameBytes(name) + valueBytes(element) + 1,
    3,
  );
}

/**
 * The size DynamoDB counts a row at against its item limit.
 *
 * Accepts: `row` — a row this package is about to write, as the document
 * client would marshall it: strings, numbers, booleans, `null`, binary,
 * arrays and plain objects, nested to any depth. An `undefined` attribute is
 * counted as one byte although the client drops it, which only errs high.
 *
 * Returns: the sum, over every attribute, of its name's UTF-8 bytes and its
 * value's size: a string's UTF-8 bytes; a number's significant digits halved
 * and rounded up, plus one; binary's raw bytes; one byte for a boolean or a
 * null; and for a list or a map three bytes, plus each element's size and one
 * byte per element, a map's element also paying its name. The rules are
 * AWS's own
 * (https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/CapacityUnitCalculations.html).
 *
 * Throws: nothing.
 */
export function rowSizeBytes(row: AttributeMap): number {
  return Object.entries(row).reduce(
    (sum, [name, value]) => sum + nameBytes(name) + valueBytes(value as RowValue),
    0,
  );
}
