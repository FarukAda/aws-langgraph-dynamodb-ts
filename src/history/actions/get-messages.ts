import { type BaseMessage, mapStoredMessagesToChatMessages } from '@langchain/core/messages';

import { decodeMessages, readRawSession } from '../internal/item-mapper';
import type { HistoryContext } from '../internal/setup';

/** Return a session's messages in order, or an empty list when none exist. */
export async function getMessages(
  context: HistoryContext,
  sessionId: string,
): Promise<BaseMessage[]> {
  const item = await readRawSession(context, sessionId);
  if (!item) return [];
  const stored = await decodeMessages(context, item);
  return mapStoredMessagesToChatMessages(stored);
}
