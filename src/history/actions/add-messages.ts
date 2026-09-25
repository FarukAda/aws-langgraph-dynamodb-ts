/**
 * Hides what an append settles before its first write.
 *
 * The session id and every message are parsed before anything is sent, so a
 * message that could never be read back fails with its index and nothing
 * stored; an empty list ends here, the no-op a turn without a message is; and
 * with a ttl configured, the session's creation-anchored expiry is read first
 * so every message of the append shares it. How the rows and the count are
 * then written together is `appendMessages`' decision, not this module's.
 */

import type { BaseMessage } from '@langchain/core/messages';

import { calculateTtlTimestamp } from '../../shared/validation/ttl';
import { appendMessages } from '../internal/append';
import { parseMessages, parseSessionId } from '../internal/parse';
import { resolveTtlAnchor } from '../internal/session';
import type { HistoryContext } from '../internal/setup';

/**
 * Append messages as one item per message. Each chunk writes its message Puts
 * and the session-metadata count `ADD` in a single `TransactWriteItems`, so
 * `messageCount` can never disagree with the stored messages. A creation-anchored
 * TTL (resolved by read, set in the transaction via `if_not_exists`) gives every
 * item one shared expiry. Batches larger than the 100-item / 4 MB transaction
 * limits are split into chunks and applied with caller-observed atomicity: if a
 * later chunk fails, the committed chunks are rolled back (see {@link appendMessages}).
 *
 * Per item the 400 KB DynamoDB limit still applies; enable S3 offloading so
 * large payloads become small descriptors and stay well under the limits.
 *
 * Accepts: `messages` — LangChain messages; an empty list writes nothing and is
 * not an error, which is what a turn that produced no message means.
 * `signal` — aborts between chunks.
 *
 * Returns: nothing, and only once every message has landed.
 *
 * Throws: `VALIDATION` naming `sessionId` or `messages` (with the offending
 * index) before any write; `S3_OFFLOAD_FAILED`; whatever the transaction
 * throws, after the rollback; `COMPENSATION_FAILED` when that
 * rollback could not finish.
 *
 * Guarantees: a caller observes all messages or none. `messageCount` always
 * agrees with the messages that landed, because each chunk writes both in one
 * transaction. Every message of the append shares one creation-anchored expiry,
 * so a conversation expires whole rather than losing its oldest turns first. No
 * S3 object is left behind by a failure, at any stage — including a failure
 * partway through encoding, before the saga exists.
 */
export async function addMessages(
  context: HistoryContext,
  sessionId: string,
  messages: BaseMessage[],
  signal?: AbortSignal,
): Promise<void> {
  const session = parseSessionId(sessionId);
  const stored = parseMessages(messages);
  if (stored.length === 0) return;
  const anchor = context.ttl
    ? await resolveTtlAnchor(context, session, calculateTtlTimestamp(context.ttl), signal)
    : undefined;
  await appendMessages(context, { sessionId: session, messages: stored, anchor, signal });
}
