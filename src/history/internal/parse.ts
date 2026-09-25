/**
 * Hides the rules chat-history input must meet before anything reads it.
 *
 * A session id, an append's messages, a read window and the listing options
 * are each parsed once into a type only this module can build (record 21), so
 * an action that holds one never checks it again. Which messages may be
 * stored is decided by the read side's own rebuild, so write and read agree
 * by construction, and which instants a `before` may name follows from the
 * range a message id can express.
 */

import {
  type BaseMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type StoredMessage,
} from '@langchain/core/messages';

import { KEY_SEPARATOR, MAX_PARTITION_ID_BYTES } from '../../shared/dynamodb/table-schema';
import { validationError } from '../../shared/errors/errors';
import { redactedMessage } from '../../shared/logging/secret-patterns';
import { truncateForLog } from '../../shared/logging/truncate';
import { ULID_TIME_RANGE_MS } from '../../shared/ulid';
import { assertSignalLike } from '../../shared/validation/collaborators';
import { assertShape } from '../../shared/validation/option-shape';
import {
  type PageLimit,
  parseIdentifier,
  parseInteger,
  parseLimit,
  parseString,
} from '../../shared/validation/primitives';
import type { GetMessagesOptions, ListSessionsOptions, MessageWindow } from '../types';
import { GET_MESSAGES_KEYS, LIST_SESSIONS_KEYS } from './setup';

declare const sessionIdBrand: unique symbol;
declare const storableMessagesBrand: unique symbol;
declare const parsedWindowBrand: unique symbol;

/**
 * A session id checked as the partition key it becomes. {@link parseSessionId}
 * is the only way to obtain one, so an internal function that asks for a
 * `SessionId` cannot be handed one nobody checked, and does not check it again.
 * Each of the four history actions that take one — add, clear, get and
 * reconcile — parses it on every call, and the session adapter parses the id
 * it is bound to when it is built. The brand is phantom: at run time it is the
 * caller's string.
 */
export type SessionId = string & { readonly [sessionIdBrand]: true };

/**
 * Messages in their stored form, each one proven to rebuild on the read side.
 * Built only by {@link parseStoredMessages}; the array is the one
 * {@link parseMessages} made, which no caller holds.
 */
export type StorableMessages = StoredMessage[] & { readonly [storableMessagesBrand]: true };

/**
 * A conversation window checked against the page rule and the range a message
 * id can express, holding only the keys the caller gave. Built only by
 * {@link parseMessageWindow}; its `before` is a copy, so a caller moving its own
 * `Date` afterwards moves nothing this package reads.
 */
export type ParsedWindow = { readonly limit?: PageLimit; readonly before?: Date } & {
  readonly [parsedWindowBrand]: true;
};

/**
 * Parse a session id.
 *
 * Accepts: `value` — anything; a session id reaches the partition key, so it is
 * held to every identifier rule at {@link MAX_PARTITION_ID_BYTES}.
 *
 * Returns: `value` as a {@link SessionId}.
 *
 * Throws: `VALIDATION` naming `sessionId`.
 */
export function parseSessionId(value: unknown): SessionId {
  return parseIdentifier(value, KEY_SEPARATOR, 'sessionId', MAX_PARTITION_ID_BYTES) as SessionId;
}

/**
 * Serialize the caller's messages, reporting a value that is not a message.
 *
 * Accepts: `messages` — LangChain messages. The type says so; this runs for the
 * JavaScript caller it does not bind, and for the `any` that reaches an
 * `addMessages` through a chain. Empty is empty.
 *
 * Returns: the messages in their stored form, in order.
 *
 * Throws: `VALIDATION` naming `messages` and the offending index. Serializing
 * one message at a time is what makes that index knowable: mapping the array in
 * one call failed with `TypeError: message.toDict is not a function` from inside
 * LangChain, naming neither the message nor this library. What LangChain says
 * is quoted bounded: that text renders the offending value into itself, so it
 * is exactly as long as the caller's own object makes it, and bounding the
 * index while relaying it whole would bound nothing at all. The bound is
 * `redactedMessage`'s own and is not applied again here — a second cut would
 * mark the length of the first cut's output instead of the length the caller's
 * text really had, which is the one thing the mark exists to state.
 *
 * Walked by index rather than with `Array.prototype.map`, which keeps a hole
 * in a sparse array without visiting it: a hole is read as the `undefined` it
 * is and refused like any other value that is not a message.
 */
function toStoredMessages(messages: BaseMessage[]): StoredMessage[] {
  const stored: StoredMessage[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    try {
      stored.push(mapChatMessagesToStoredMessages([messages[index]])[0]);
    } catch (error) {
      throw validationError(
        `messages[${index}] is not a LangChain message: ` + redactedMessage(error as Error),
        'messages',
      );
    }
  }
  return stored;
}

/**
 * Parse stored messages: prove each one rebuilds on the read side.
 *
 * Accepts: `stored` — the stored form of one call's messages. The check *is*
 * the read side's own rebuild (`mapStoredMessagesToChatMessages`), so write and
 * read agree by construction rather than by two lists of types kept in step by
 * hand.
 *
 * Returns: `stored`, as {@link StorableMessages}.
 *
 * Throws: `VALIDATION` naming `messages`, carrying the offending index and
 * type. The type comes off the caller's own object and nothing length-checked
 * it, so the message names it bounded by {@link truncateForLog}, and so is
 * what LangChain says about it — that text renders the same unchecked value
 * into itself, so bounding only the type bounds nothing. The two take
 * different caps because they are different things: the type is an identifier,
 * while what LangChain threw is prose, cut once by `redactedMessage` and not
 * again here. `context` still names `messages`, which is what a caller
 * branches on. A `RemoveMessage`, or a tool, function or generic message
 * missing its required field, is refused here instead of being persisted and
 * then skipped or thrown by `getMessages`. A hole in a sparse array is refused
 * as missing, naming its index: the array is walked by index, where
 * `Array.prototype.forEach` would skip the hole and let it through.
 */
export function parseStoredMessages(stored: StoredMessage[]): StorableMessages {
  for (let index = 0; index < stored.length; index += 1) {
    const message: StoredMessage | undefined = stored[index];
    if (message === undefined) {
      throw validationError(`messages[${index}] is missing`, 'messages');
    }
    try {
      mapStoredMessagesToChatMessages([message]);
    } catch (error) {
      throw validationError(
        `messages[${index}] of type "${truncateForLog(message.type)}" cannot be stored: ` +
          redactedMessage(error as Error),
        'messages',
      );
    }
  }
  return stored as StorableMessages;
}

/**
 * Parse the messages of one append, in two passes: to the stored form, then
 * proof that each rebuilds.
 *
 * Accepts: `messages` — declared `BaseMessage[]`; a non-array is refused, and
 * so is an entry LangChain cannot serialize.
 *
 * Returns: a fresh array of stored messages, as {@link StorableMessages}.
 *
 * Throws: `VALIDATION` naming `messages`, with the offending index for an
 * entry.
 */
export function parseMessages(messages: BaseMessage[]): StorableMessages {
  if (!Array.isArray(messages)) {
    throw validationError('messages must be an array', 'messages');
  }
  return parseStoredMessages(toStoredMessages(messages));
}

/**
 * A window's `before`, as a copy, when a message id can express it: the bound
 * is the message id of that instant, and a message id holds its millisecond in
 * ten base-32 characters.
 *
 * `null` is refused, naming `before`, rather than read as "up to now". A
 * `Date` is duck-typed, since one from another realm is still a date.
 * Unchecked, `before: null` would reach `null.getTime`, a property access the
 * boundary brands `UNEXPECTED_ERROR` instead of naming the caller's mistake;
 * an invalid `Date` would otherwise derive a NaN sort key that matches nothing
 * and read as an empty conversation. A pre-epoch `Date` would be worse than
 * either: the bound built from it sorts above every real id, so the window
 * would come back holding the entire conversation the caller asked to exclude.
 * Past the range the bound would wrap to the lowest prefix and the window would
 * come back empty.
 */
function windowBound(before: Date): Date {
  const hasGetTime = before !== null && typeof before.getTime === 'function';
  const time = hasGetTime ? before.getTime() : Number.NaN;
  if (!Number.isFinite(time)) throw validationError('before must be a valid Date', 'before');
  if (time < 0 || time >= ULID_TIME_RANGE_MS) {
    throw validationError(
      'before must be a Date from the epoch onwards and before the year 37648: the bound is ' +
        'the message id of that instant, and a message id encodes its millisecond in ten ' +
        'base-32 characters, which hold no instant outside that range',
      'before',
    );
  }
  return new Date(time);
}

/**
 * Parse a conversation window.
 *
 * Accepts: `window.limit` — an integer from 1 to the page ceiling; the only
 * floor of 1 in the package, because a window feeds a model, and an empty
 * conversation is not a visibly empty answer but an invented one.
 * `window.before` — a valid `Date` inside the range a message id can express.
 *
 * Returns: a fresh window holding only the keys the caller gave, as a
 * {@link ParsedWindow}.
 *
 * Throws: `VALIDATION` naming `limit` or `before`.
 */
export function parseMessageWindow(window: MessageWindow): ParsedWindow {
  const parsed: { limit?: PageLimit; before?: Date } = {};
  if (window.limit !== undefined) parsed.limit = parseLimit(window.limit, 1);
  if (window.before !== undefined) parsed.before = windowBound(window.before);
  return parsed as ParsedWindow;
}

/** The arguments of `getMessages`, parsed. */
export interface GetMessagesRequest {
  readonly sessionId: SessionId;
  readonly window: ParsedWindow;
  readonly signal: AbortSignal | undefined;
}

/**
 * Parse the arguments of `getMessages`.
 *
 * Accepts: `sessionId` — as {@link parseSessionId}. `options` — an object with
 * only `limit`, `before` and `signal`; the window as {@link parseMessageWindow}.
 *
 * Returns: the request the read works from.
 *
 * Throws: `VALIDATION`, in this order: `options.<key>`, `signal`, `sessionId`,
 * `limit`, `before`.
 */
export function parseGetMessagesRequest(
  sessionId: string,
  options: GetMessagesOptions,
): GetMessagesRequest {
  assertShape(options, GET_MESSAGES_KEYS, 'options');
  assertSignalLike(options.signal);
  const parsedSessionId = parseSessionId(sessionId);
  return {
    sessionId: parsedSessionId,
    window: parseMessageWindow(options),
    signal: options.signal,
  };
}

/** The options of `listSessions`, parsed. */
export interface ListSessionsRequest {
  readonly limit: PageLimit | undefined;
  readonly maxItems: number | undefined;
  readonly maxIterations: number | undefined;
  readonly cursor: string | undefined;
  readonly signal: AbortSignal | undefined;
}

/** A scan cap: absent and `Infinity` both mean none; anything else is an integer of at least 1. */
function scanCap(value: number | undefined, field: string): number | undefined {
  if (value === undefined || value === Infinity) return value;
  return parseInteger(value, field, { min: 1 });
}

/**
 * The paging cursor, which only the recency index can honour: without it a
 * listing is one table scan, which has no position to resume from.
 */
function pageCursor(cursor: string | undefined, indexName: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  if (indexName === undefined) {
    throw validationError(
      'paging by cursor needs a configured `indexName`: without the recency index a listing is ' +
        'one table scan, which has no position to resume from',
      'cursor',
    );
  }
  return parseString(cursor, 'cursor');
}

/**
 * Parse the options of `listSessions`.
 *
 * Accepts: `options` — only `limit`, `cursor`, `maxIterations`, `maxItems` and
 * `signal`. `limit` — 0 to the page ceiling; `0` is answered with an empty page.
 * `maxItems`, `maxIterations` — an integer of at least 1, or `Infinity`.
 * `cursor` — a string, and only with `indexName`. `indexName` — the adapter's
 * configured recency index, if any.
 *
 * Returns: the request the listing works from.
 *
 * Throws: `VALIDATION`, in this order: `options.<key>`, `signal`, `limit`,
 * `maxItems`, `maxIterations`, `cursor`.
 */
export function parseListSessionsRequest(
  options: ListSessionsOptions,
  indexName: string | undefined,
): ListSessionsRequest {
  assertShape(options, LIST_SESSIONS_KEYS, 'options');
  assertSignalLike(options.signal);
  const limit = options.limit === undefined ? undefined : parseLimit(options.limit, 0);
  const maxItems = scanCap(options.maxItems, 'maxItems');
  const maxIterations = scanCap(options.maxIterations, 'maxIterations');
  return {
    limit,
    maxItems,
    maxIterations,
    cursor: pageCursor(options.cursor, indexName),
    signal: options.signal,
  };
}
