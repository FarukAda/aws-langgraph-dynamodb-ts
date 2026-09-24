/**
 * Hides the JSON form: writing it, reading it, and recognising it.
 *
 * The default serde writes a value as JSON under the `json` type and reads
 * back only that type; the codec also asks, when a serde refuses stored bytes,
 * whether those bytes are still JSON at all, which tells a corrupt payload from
 * a serde that would not reconstruct it.
 */

import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { DynamoDBLangGraphError } from '../errors/base-error';
import { ErrorCode } from '../errors/error-code';
import { validationError } from '../errors/errors';
import { toError } from '../errors/to-error';
import { truncateForLog } from '../logging/truncate';

/**
 * A plain JSON serializer implementing LangGraph's `SerializerProtocol`:
 * the default `serde` of `DynamoDBStore` and `DynamoDBChatMessageHistory`, and
 * the alternative a `DynamoDBSaver` can be given in place of LangGraph's
 * `JsonPlusSerializer`.
 *
 * It is exported so that choice is available. The checkpointer's default
 * revives a stored `{"lc": …}` record by instantiating the class the record
 * names, so the row selects which constructor runs on read; this serializer
 * runs `JSON.parse` and nothing else, and reconstructs no class at all.
 * Reading with it is the narrower trust boundary, and the price is stated
 * below: it stores the JSON projection of a value, not the value.
 *
 * `dumpsTyped` accepts any value `JSON.stringify` can represent and refuses the
 * rest. A value it cannot represent — `undefined`, a function, a symbol —
 * stringifies to `undefined` and would be stored as **zero bytes**, which reads
 * back as a parse error; a circular structure or a `BigInt` makes it throw. Both
 * are reported as `VALIDATION` naming `value`, at the write, rather than
 * as an unreadable row later — with the refusal attached as `cause` and never
 * quoted into the message, which for a circular structure names the caller's
 * own properties and classes.
 *
 * What it represents, it represents as JSON, which is lossy in ways nothing
 * records: a `Map` or `Set` stores as `{}`, an object key whose value is
 * `undefined` is dropped and an array element is stored as `null`, `NaN` and
 * `Infinity` store as `null`, `-0` as `0`, a `Uint8Array` as an index-keyed
 * object and a `Date` as an ISO string. The README's *Table schema* section
 * holds the whole table, against the checkpointer default column by column.
 *
 * `loadsTyped` reads only the `json` form it writes, and says
 * so before it looks at a byte. Any other declared form is a `VALIDATION` error
 * naming `serde`, because it says what *this* reader may rebuild and not that
 * the payload is damaged. Bytes of that form which do not parse are
 * `PAYLOAD_CORRUPT`, because they can never be read and the caller should
 * report rather than retry; a `data` that is not bytes at all is a
 * `VALIDATION` naming `data`, because that is the caller's mistake and
 * not a row's.
 *
 * Frozen for the reason {@link ErrorCode} is: one object, shared by every
 * adapter in the process that did not pass a `serde` of its own, and now
 * reachable from the package root. An assignment to `dumpsTyped` by any one
 * consumer would silently change how every other one writes.
 */
export const JSON_SERDE: SerializerProtocol = {
  async dumpsTyped(value) {
    let text: string | undefined;
    try {
      text = JSON.stringify(value);
    } catch (error) {
      /**
       * The refusal travels as `cause`, never as text. V8 writes the path it
       * walked into the message it throws for a circular structure, quoting
       * the caller's own property names and constructor names — and this
       * package does not compose a public `err.message` out of a caller's
       * identifiers, which an application may print, log or return in a
       * response. `redactedMessage` removes credential shapes, not names, so
       * it never covered this. A caller who wants the path reads `cause`.
       */
      throw validationError(
        'value cannot be serialized as JSON — a circular structure, or a value JSON has no ' +
          'encoding for such as a BigInt; the refusal itself is attached as `cause`',
        'value',
        toError(error as Error),
      );
    }
    if (text === undefined) {
      throw validationError(
        'value has no JSON representation (undefined, a function or a symbol), so it cannot be ' +
          'stored; store null instead to record an absent value',
        'value',
      );
    }
    /**
     * `dumpsTyped` stays `async` because the two throws above must reach a
     * caller as a rejection even when it is called without `await` (a bare
     * `.catch()`), which a plain synchronous throw would not do. Returning
     * `Promise.resolve(...)` here — rather than the bare tuple — is what
     * satisfies `require-await`: the rule accepts a `return` of a thenable
     * value in place of an explicit `await`, and needs no `await` to do it.
     */
    return Promise.resolve([JSON_SERDE_TYPE, new TextEncoder().encode(text)]);
  },
  async loadsTyped(type, data) {
    /**
     * The declared form is honoured, and honoured first. Ignoring it left this
     * serializer answering for forms it has no grammar for: a row stamped
     * `bytes` by the checkpointer's default — what that serializer writes for a
     * raw `Uint8Array` — parsed here as JSON and returned a *different value*
     * whenever those bytes happened to be valid JSON, and returned this
     * serializer's own `PAYLOAD_CORRUPT` when they were not. The second reading
     * is the one that cost data: the codec passes an already-branded refusal
     * through untouched, so `bytesHoldDeclaredForm` never ran, the row was
     * filed as permanent loss, and history's default `onCorruptMessage: 'skip'`
     * dropped the message. The same row read through the checkpointer's own
     * default was reported as a refusal instead, so which serde an adapter
     * carried decided whether a turn survived the read.
     *
     * A form this serializer cannot rebuild a value from is a statement about
     * this reader, not about the payload, so it names `serde` — the same brand
     * the codec puts on `JsonPlusSerializer`'s `Unknown serialization type`,
     * which is what makes the two agree. The type is quoted from the row, so it
     * is bounded, for the reason `truncateForLog` states.
     */
    if (type !== JSON_SERDE_TYPE) {
      throw validationError(
        `this serializer reads only the \`${JSON_SERDE_TYPE}\` form it writes, and this payload ` +
          `declares ${truncateForLog(String(JSON.stringify(type)))}; read the row with the ` +
          'serializer that wrote it, or rewrite the row',
        'serde',
      );
    }
    let text: string;
    /**
     * The decode is inside a guard of its own because it fails for a different
     * reason than the parse does, and now says so. UTF-8 decoding is lenient —
     * a malformed byte becomes U+FFFD rather than an error — so the only way
     * `TextDecoder` refuses is a `data` that is not bytes at all, which is the
     * caller's mistake and not a corrupt row. Before this export that value
     * could only come from the codec, which hands it a `Uint8Array`; a direct
     * caller got a bare `TypeError` from Node naming an argument called
     * "list".
     */
    try {
      text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    } catch (error) {
      throw validationError(
        'data must be the bytes or text this serializer wrote, as a Uint8Array or a string',
        'data',
        error as Error,
      );
    }
    try {
      /** Same reasoning as `dumpsTyped`'s final return: see its comment. */
      return Promise.resolve(JSON.parse(text));
    } catch (error) {
      throw new DynamoDBLangGraphError(
        'the stored payload is not the JSON this serializer wrote, so it cannot be decoded',
        ErrorCode.PAYLOAD_CORRUPT,
        {},
        error as Error,
      );
    }
  },
};

Object.freeze(JSON_SERDE);

/**
 * The one `serdeType` whose grammar this package can check for itself: the type
 * `JSON_SERDE` stamps on everything it writes, and the one LangGraph's
 * own `JsonPlusSerializer` stamps on every value but a raw `Uint8Array`, which
 * it stamps `bytes`.
 *
 * The one constant is shared by the serializer that writes this form and the
 * check that re-derives it, within this module. They had each decided
 * separately what they understood: the check took any other type at its
 * word, while `JSON_SERDE` ignored the declared type and ran `JSON.parse` on
 * whatever it was handed. A row declaring a form neither of them writes was
 * therefore classified one way through one serializer and the opposite way
 * through the other — and a row declaring `bytes`, which the checkpointer's
 * default writes for a raw `Uint8Array`, decoded to a *different value*
 * rather than failing at all when its bytes happened to parse as JSON.
 */
const JSON_SERDE_TYPE = 'json';

/**
 * Whether stored bytes are still the form the row that holds them declares.
 *
 * This is the structural question behind the two ways a decode fails —
 * `PAYLOAD_CORRUPT` for bytes no reader can decode, and the `serde` refusal for
 * bytes *this* reader will not rebuild a value from — and it is the only one
 * this package can answer on its own. `SerializerProtocol` offers no way to ask
 * a serde whether it parsed the bytes before deciding not to reconstruct what
 * they name, and the refusal it throws is a caller's object: its class, its
 * fields and its prose are all whatever that caller chose. Classifying a
 * payload by any of those would make the code mean "a third party said so",
 * which is exactly what neither code may mean.
 *
 * Accepts: `serdeType` — the type stamped on the row, as the descriptor carries
 * it. `bytes` — what the row stored, already decompressed.
 *
 * Returns: whether the bytes still parse as the declared form. A type this
 * package has no grammar for is taken at its word and answers `true`, so its
 * serde's refusal is reported rather than written off: dropping a payload this
 * reader merely cannot check would lose data on nothing but its own ignorance.
 *
 * Throws: **nothing**, for any bytes. It is called from inside the `catch` that
 * is classifying a decode failure, where a throw would replace the failure
 * being reported — and the value it is handed came off a row, so it may be
 * anything that row's writer stored.
 */
export function bytesHoldDeclaredForm(serdeType: string, bytes: Uint8Array): boolean {
  if (serdeType !== JSON_SERDE_TYPE) return true;
  try {
    JSON.parse(new TextDecoder().decode(bytes));
    return true;
  } catch {
    return false;
  }
}
