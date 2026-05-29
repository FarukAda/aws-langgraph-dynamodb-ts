import type { StoredMessage } from '@langchain/core/messages';

import { type CodecDeps, decodePayload, encodePayload } from '../../shared/codec/codec';
import { withDynamoDBRetry } from '../../shared/dynamodb/retry';
import type { ChatSessionItem } from '../types';
import { SESSION_SORT_KEY, sessionPartition } from './keys';
import type { HistoryContext } from './setup';

function codecDeps(context: HistoryContext): CodecDeps {
  return { serde: context.serde, compression: context.compression, offloader: context.offloader };
}

/** Read the raw session item, or undefined when the session does not exist. */
export async function readRawSession(
  context: HistoryContext,
  sessionId: string,
): Promise<ChatSessionItem | undefined> {
  const result = await withDynamoDBRetry(() =>
    context.client.get({
      TableName: context.tableName,
      Key: { PK: sessionPartition(sessionId), SK: SESSION_SORT_KEY },
    }),
  );
  return result.Item as ChatSessionItem | undefined;
}

/** Decode the stored messages held in a session item. */
export async function decodeMessages(
  context: HistoryContext,
  item: ChatSessionItem,
): Promise<StoredMessage[]> {
  return decodePayload<StoredMessage[]>(item.messages, codecDeps(context));
}

/** Fields controlling a built session item beyond its message list. */
export interface BuildSessionOptions {
  version: number;
  createdAt: string;
  updatedAt: string;
  title?: string;
  ttlTimestamp?: number;
}

/** Encode a full message list into the session's DynamoDB item. */
export async function buildSessionItem(
  context: HistoryContext,
  sessionId: string,
  messages: StoredMessage[],
  options: BuildSessionOptions,
): Promise<ChatSessionItem> {
  const descriptor = await encodePayload(messages, codecDeps(context), {
    keyParts: [sessionId, 'messages'],
  });
  const item: ChatSessionItem = {
    PK: sessionPartition(sessionId),
    SK: SESSION_SORT_KEY,
    sessionId,
    messages: descriptor,
    messageCount: messages.length,
    version: options.version,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
  };
  if (options.title !== undefined) item.title = options.title;
  if (options.ttlTimestamp !== undefined) item.ttl = options.ttlTimestamp;
  return item;
}
