import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  type BaseListChatMessageHistory,
  InMemoryChatMessageHistory,
} from '@langchain/core/chat_history';
import { AIMessage, type BaseMessage } from '@langchain/core/messages';
import { RunnableLambda, RunnableWithMessageHistory } from '@langchain/core/runnables';

import { DynamoDBChatMessageHistory } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from './helpers/ddb-local';

const tableName = 'history-differential-itest';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let history: DynamoDBChatMessageHistory;
const memories = new Map<string, InMemoryChatMessageHistory>();

beforeAll(async () => {
  await createTable(admin, tableName);
  history = new DynamoDBChatMessageHistory({ tableName, clientConfig: DDB_LOCAL_CONFIG });
});

afterAll(async () => {
  history.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

/** The chain input; RunnableWithMessageHistory injects `history` before the lambda runs. */
interface Turn {
  input: string;
  history?: BaseMessage[];
}

/** A chain whose reply encodes how much history it was handed, so a lost or duplicated message changes the output. */
function chain(getMessageHistory: (sessionId: string) => BaseListChatMessageHistory) {
  return new RunnableWithMessageHistory({
    runnable: RunnableLambda.from(
      async (turn: Turn) => new AIMessage(`${(turn.history ?? []).length} before: ${turn.input}`),
    ),
    getMessageHistory,
    inputMessagesKey: 'input',
    historyMessagesKey: 'history',
  });
}

function memoryFor(sessionId: string): InMemoryChatMessageHistory {
  let memory = memories.get(sessionId);
  if (!memory) {
    memory = new InMemoryChatMessageHistory();
    memories.set(sessionId, memory);
  }
  return memory;
}

describe('DynamoDBChatMessageHistory under RunnableWithMessageHistory matches the in-memory history (TEST-06)', () => {
  it('produces the same replies and stored transcripts across two sessions and three turns', async () => {
    const ours = chain((sessionId) => history.forSession(sessionId));
    const theirs = chain(memoryFor);
    for (const turn of ['one', 'two', 'three']) {
      for (const sessionId of ['s1', 's2']) {
        const config = { configurable: { sessionId } };
        const input = { input: `${sessionId}-${turn}` };
        const [reply, reference] = await Promise.all([
          ours.invoke(input, config),
          theirs.invoke(input, config),
        ]);
        expect(reply.content).toEqual(reference.content);
      }
    }
    for (const sessionId of ['s1', 's2']) {
      const [stored, reference] = await Promise.all([
        history.getMessages(sessionId),
        memoryFor(sessionId).getMessages(),
      ]);
      const transcript = (messages: BaseMessage[]) =>
        messages.map((message) => [message.getType(), message.content]);
      expect(transcript(stored)).toEqual(transcript(reference));
      expect(stored).toHaveLength(6);
    }
  });
});
