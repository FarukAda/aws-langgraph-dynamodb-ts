import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getCheckpointTuple } from '../../../../src/checkpointer/actions/get-tuple';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { getMessages } from '../../../../src/history/actions/get-messages';
import { parseSessionId } from '../../../../src/history/internal/parse';
import { buildMessageRow } from '../../../../src/history/internal/rows';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import {
  DESCRIPTOR_SCHEMA_VERSION,
  PayloadLocation,
  isPermanentPayloadLoss,
} from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { getItem } from '../../../../src/store/internal/get-item';
import { parseStoreAddress } from '../../../../src/store/internal/parse';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/**
 * The same condition on all three adapters: a payload whose descriptor declares
 * a schema version newer than this release reads. Nothing about it is damaged —
 * the release that wrote it reads it perfectly — so it is the same answer the
 * row guard gives for a forward `v`, and it must reach the caller rather than
 * be written off.
 *
 * Inside history alone the two guards for the identical condition used to
 * answer oppositely: a forward `v` raised, and a forward `schemaVersion` was
 * skipped, because it shared its code and field with the descriptor refusals
 * that really are permanent. A rollback or a canary therefore lost turns on
 * history that the store and the saver still refused to serve.
 */
const CONFIGURABLE = { configurable: { thread_id: 't' } };

/** A descriptor written by a release this one does not know how to read. */
function forwardDescriptor(): Record<string, unknown> {
  return {
    schemaVersion: DESCRIPTOR_SCHEMA_VERSION + 1,
    location: PayloadLocation.INLINE,
    serdeType: 'json',
    compressed: false,
    bytes: new TextEncoder().encode('{"a":1}'),
  };
}

/** `history.getMessages` under the default `'skip'` policy, reading one such row. */
async function readHistory(): Promise<unknown> {
  const { client, mock } = createStrictDocumentMock();
  const context: HistoryContext = {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    onCorruptMessage: 'skip',
  };
  const [human] = mapChatMessagesToStoredMessages([new HumanMessage('a turn')]);
  const item = await buildMessageRow(context, {
    sessionId: parseSessionId('s1'),
    messageId: '01A',
    message: human,
  });
  item.message = forwardDescriptor() as never;
  mock.on(QueryCommand).resolves({ Items: [item] });
  return getMessages(context, 's1');
}

/** `store.getItem`, reading one such row. */
async function readStore(): Promise<unknown> {
  const { client, mock } = createStrictDocumentMock();
  const context: StoreContext = {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    maxIterations: 1000,
    vectorScoreDirection: 'relevance',
  };
  mock.on(GetCommand).resolves({
    Item: {
      PK: 'STORE#users',
      SK: 'u1#profile',
      namespace: ['users', 'u1'],
      key: 'profile',
      createdAt: 'c',
      updatedAt: 'u',
      value: forwardDescriptor(),
    },
  });
  return getItem(context, parseStoreAddress(['users', 'u1'], 'profile'));
}

/** `saver.getTuple`, reading one such checkpoint payload row. */
async function readCheckpointer(): Promise<unknown> {
  const { client, mock } = createStrictDocumentMock();
  const meta = {
    PK: 'CHKPT#t',
    SK: 'META##ckpt-1',
    threadId: 't',
    checkpointNs: '',
    checkpointId: 'ckpt-1',
    metadata: {
      location: PayloadLocation.INLINE,
      serdeType: 'json',
      compressed: false,
      bytes: new TextEncoder().encode('{}'),
    },
  };
  mock
    .on(QueryCommand)
    .callsFake((input: { ExpressionAttributeValues: Record<string, unknown> }) =>
      (input.ExpressionAttributeValues[':skPrefix'] as string).startsWith('META')
        ? { Items: [meta] }
        : { Items: [] },
    );
  mock.on(GetCommand).resolves({
    Item: { PK: 'CHKPT#t', SK: 'PAYLOAD##ckpt-1', checkpoint: forwardDescriptor() },
  });
  const context: CheckpointerContext = {
    client,
    tableName: 'ckpt',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
  };
  return getCheckpointTuple(context, CONFIGURABLE);
}

const ADAPTERS: readonly [string, () => Promise<unknown>][] = [
  ['history.getMessages', readHistory],
  ['store.getItem', readStore],
  ['saver.getTuple', readCheckpointer],
];

/** What one adapter answered: the branded shape, or the absence of a throw. */
async function answerOf(read: () => Promise<unknown>): Promise<{
  name?: string;
  code?: string;
  field?: string;
}> {
  try {
    await read();
    return {};
  } catch (error) {
    const coded = error as { name: string; code?: string; context?: { field?: string } };
    return { name: coded.name, code: coded.code, field: coded.context?.field };
  }
}

describe('a payload a newer release wrote is an unsupported format, not payload loss', () => {
  it.each(ADAPTERS)('%s raises rather than reading past the row', async (_name, read) => {
    expect(await answerOf(read)).toEqual({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.FORMAT_UNSUPPORTED,
      field: 'schemaVersion',
    });
  });

  it('answers alike on all three adapters, so no row shape is skipped on one and raised on another', async () => {
    const answers = await Promise.all(ADAPTERS.map(([, read]) => answerOf(read)));
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });

  /**
   * History's two guards for the one condition now agree: the row's `v` and the
   * payload's `schemaVersion` are the same statement about the same write, and
   * a reader that refuses one while dropping the other loses turns silently on
   * exactly the deployment — a rollback, a canary — where both fire.
   */
  it('answers a forward payload the way the row guard answers a forward row', async () => {
    const { client, mock } = createStrictDocumentMock();
    const context: HistoryContext = {
      client,
      tableName: 'history',
      serde: JSON_SERDE,
      logger: SILENT_LOGGER,
      ulid: () => 'U',
      onCorruptMessage: 'skip',
    };
    const [human] = mapChatMessagesToStoredMessages([new HumanMessage('a turn')]);
    const item = await buildMessageRow(context, {
      sessionId: parseSessionId('s1'),
      messageId: '01A',
      message: human,
    });
    mock.on(QueryCommand).resolves({ Items: [{ ...item, v: 99 }] });
    const forwardRow = await answerOf(() => getMessages(context, 's1'));
    const forwardPayload = await answerOf(readHistory);
    expect(forwardRow.code).toBe(forwardPayload.code);
  });

  /**
   * The bucket justifies itself as "no other reader would fare better", which
   * is flatly false here: a newer reader reads this payload.
   */
  it('is not permanent payload loss, so no policy may write it off', () => {
    const forward = new DynamoDBLangGraphError('newer', ErrorCode.FORMAT_UNSUPPORTED, {
      field: 'schemaVersion',
    });
    expect(isPermanentPayloadLoss(forward)).toBe(false);
  });
});
