/**
 * Add a single message to a session.
 *
 * Thin wrapper around {@link addMessagesAction} with a 1-element array. Single-
 * and multi-message writes share the exact same optimistic-concurrency path;
 * keeping one implementation avoids behavioural drift (and removes duplication).
 */

import type { AddMessageActionParams } from '../types';
import { addMessagesAction } from './add-messages';

export const addMessageAction = async (params: AddMessageActionParams): Promise<void> => {
  await addMessagesAction({
    client: params.client,
    tableName: params.tableName,
    userId: params.userId,
    sessionId: params.sessionId,
    messages: [params.message],
    title: params.title,
    ttlDays: params.ttlDays,
  });
};
