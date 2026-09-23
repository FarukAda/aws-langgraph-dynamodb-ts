import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { getCheckpointTuple } from '../../../../src/checkpointer/actions/get-tuple';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import { getMessages } from '../../../../src/history/actions/get-messages';
import { buildMessageItem } from '../../../../src/history/internal/item-mapper';
import { parseSessionId } from '../../../../src/history/internal/parse';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { loadPayloadValue, PayloadLocation } from '../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { isPermanentPayloadLoss } from '../../../../src/shared/codec/payload-loss';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { getItem } from '../../../../src/store/internal/get-item';
import { parseStoreAddress } from '../../../../src/store/internal/parse';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/**
 * The same condition on all three adapters: a row whose stored payload is an
 * `lc` constructor record naming a class outside the allow-list the serializer
 * carries. The bytes parse and nothing about them is damaged — what refuses is
 * the reader's own trust boundary — so every adapter must report it rather than
 * one of them returning a shorter answer.
 */
const CONFIGURABLE = { configurable: { thread_id: 't' } };

/** A record `dumpsTyped` writes for a LangChain object, naming a class no allow-list carries. */
const FOREIGN_RECORD = JSON.stringify({
  lc: 1,
  type: 'constructor',
  id: ['not_a_langchain_package', 'NotAClass'],
  kwargs: {},
});

/** The descriptor such a row carries: an inline payload holding that record. */
function foreignDescriptor(): Record<string, unknown> {
  return {
    location: PayloadLocation.INLINE,
    serdeType: 'json',
    compressed: false,
    bytes: new TextEncoder().encode(FOREIGN_RECORD),
  };
}

/**
 * The serializer a saver gets when the caller names none. It is taken from a
 * real adapter rather than restated, because the point of the row is what
 * LangGraph's own default does with it, and the other two adapters are then
 * given that same object.
 */
function defaultSerde(): SerializerProtocol {
  const { client } = createStrictDocumentMock();
  return new DynamoDBSaver({ tableName: 'ckpt', client, logger: SILENT_LOGGER }).serde;
}

/** The two rows `getTuple` reads: a decodable META, and a PAYLOAD holding the foreign record. */
function seedCheckpointRows(mock: ReturnType<typeof createStrictDocumentMock>['mock']): void {
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
    Item: { PK: 'CHKPT#t', SK: 'PAYLOAD##ckpt-1', checkpoint: foreignDescriptor() },
  });
}

/** `history.getMessages` under the default `'skip'` policy, reading one such row. */
async function readHistory(serde: SerializerProtocol): Promise<unknown> {
  const { client, mock } = createStrictDocumentMock();
  const context: HistoryContext = {
    client,
    tableName: 'history',
    serde,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    onCorruptMessage: 'skip',
  };
  const [human] = mapChatMessagesToStoredMessages([new HumanMessage('hi')]);
  const item = await buildMessageItem(context, parseSessionId('s1'), '01A', human);
  item.message = foreignDescriptor() as never;
  mock.on(QueryCommand).resolves({ Items: [item] });
  return getMessages(context, 's1');
}

/** `store.getItem`, reading one such row. */
async function readStore(serde: SerializerProtocol): Promise<unknown> {
  const { client, mock } = createStrictDocumentMock();
  const context: StoreContext = {
    client,
    tableName: 'store',
    serde,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
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
      value: foreignDescriptor(),
    },
  });
  return getItem(context, parseStoreAddress(['users', 'u1'], 'profile'));
}

/** `saver.getTuple`, reading one such checkpoint payload row. */
async function readCheckpointer(serde: SerializerProtocol): Promise<unknown> {
  const { client, mock } = createStrictDocumentMock();
  seedCheckpointRows(mock);
  const context: CheckpointerContext = { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
  return getCheckpointTuple(context, CONFIGURABLE);
}

const ADAPTERS: readonly [string, (serde: SerializerProtocol) => Promise<unknown>][] = [
  ['history.getMessages', readHistory],
  ['store.getItem', readStore],
  ['saver.getTuple', readCheckpointer],
];

/** What one adapter answered: the branded shape, or the absence of a throw. */
async function answerOf(
  read: (serde: SerializerProtocol) => Promise<unknown>,
): Promise<{ name?: string; code?: string; field?: string }> {
  try {
    await read(defaultSerde());
    return {};
  } catch (error) {
    const coded = error as { name: string; code?: string; context?: { field?: string } };
    return { name: coded.name, code: coded.code, field: coded.context?.field };
  }
}

describe('a payload naming a class outside the allow-list is a refusal, not payload loss', () => {
  it.each(ADAPTERS)('%s raises rather than reading past the row', async (_name, read) => {
    expect(await answerOf(read)).toEqual({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.VALIDATION,
      field: 'serde',
    });
  });

  it('answers alike on all three adapters, so no row shape is skipped on one and raised on another', async () => {
    const answers = await Promise.all(ADAPTERS.map(([, read]) => answerOf(read)));
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });

  /**
   * The refusal is the reader's, not the payload's: a serializer whose
   * allow-list carries the class reads the very same row. Classifying it as
   * loss would make `history` alone answer with a silently shorter
   * conversation, which is the failure a caller cannot detect.
   */
  it('is not classified as permanent payload loss', () => {
    const answer = { code: ErrorCode.VALIDATION, context: { field: 'serde' } };
    expect(isPermanentPayloadLoss(answer as never)).toBe(false);
  });
});

/** What `saver.getTuple` raises for the row, as a caller of the class sees it. */
async function refusalAtTheBoundary(): Promise<Error> {
  const { client, mock } = createStrictDocumentMock();
  seedCheckpointRows(mock);
  const saver = new DynamoDBSaver({ tableName: 'ckpt', client, logger: SILENT_LOGGER });
  return saver.getTuple(CONFIGURABLE).then(
    () => new Error('getTuple resolved rather than refusing the row'),
    (raised: Error) => raised,
  );
}

describe('the refusal at the public boundary', () => {
  it('reaches a caller branded, not rebranded as an AWS failure', async () => {
    expect(await refusalAtTheBoundary()).toMatchObject({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.VALIDATION,
      context: { field: 'serde' },
    });
  });

  /**
   * `guardPublic` could only wrap the bare `Error` LangChain raises, and the
   * wrapper quotes what it wraps — so the row's own stored record was
   * copied into `err.message`, which an application may print with no redacting
   * logger in the path. The branded message names the condition instead and
   * leaves the record on `cause`.
   */
  it('names the condition without copying the stored record into its message', async () => {
    const error = await refusalAtTheBoundary();
    expect(error.message).not.toContain('not_a_langchain_package');
    expect((error as { cause?: Error }).cause).toBeDefined();
  });
});

describe('loadPayloadValue', () => {
  const bytes = new TextEncoder().encode('{"a":1}');

  it('returns what the serde reconstructs', async () => {
    expect(await loadPayloadValue('json', bytes, { serde: JSON_SERDE })).toEqual({ a: 1 });
  });

  /** A code assigned closer to the failure wins, exactly as it does at the public boundary. */
  it('passes a branded refusal through unchanged', async () => {
    const corrupt = new TextEncoder().encode('{not json');
    await expect(loadPayloadValue('json', corrupt, { serde: JSON_SERDE })).rejects.toMatchObject({
      code: ErrorCode.PAYLOAD_CORRUPT,
    });
  });

  it('brands a bare error from a third-party serde and keeps it as the cause', async () => {
    const refusal = new Error('Invalid namespace');
    const serde = {
      dumpsTyped: JSON_SERDE.dumpsTyped,
      loadsTyped: (): Promise<never> => {
        throw refusal;
      },
    };
    const error = await loadPayloadValue('json', bytes, { serde }).catch((raised: Error) => raised);
    expect(error).toMatchObject({ code: ErrorCode.VALIDATION, context: { field: 'serde' } });
    expect((error as { cause?: Error }).cause).toBe(refusal);
  });

  /** A serde is a caller's object and may throw anything a `throw` produces. */
  it('brands a serde that throws something that is not an error at all', async () => {
    const serde = {
      dumpsTyped: JSON_SERDE.dumpsTyped,
      loadsTyped: (): Promise<never> => {
        throw 'refused';
      },
    };
    await expect(loadPayloadValue('json', bytes, { serde })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'serde' },
    });
  });
});
