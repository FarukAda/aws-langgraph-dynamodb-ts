import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';

import { getCheckpointTuple } from '../../../../../src/checkpointer/actions/get-tuple';
import type { CheckpointerContext } from '../../../../../src/checkpointer/internal/setup';
import { getMessages } from '../../../../../src/history/actions/get-messages';
import { buildMessageItem } from '../../../../../src/history/internal/item-mapper';
import type { HistoryContext } from '../../../../../src/history/internal/setup';
import { PayloadLocation } from '../../../../../src/shared/codec/codec';
import { JSON_SERDE } from '../../../../../src/shared/codec/json-serde';
import { buildS3Key } from '../../../../../src/shared/codec/s3/config';
import { assertKeyInScope } from '../../../../../src/shared/codec/s3/key-scope';
import { ErrorCode } from '../../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../../src/shared/logging/logger';
import { getItem } from '../../../../../src/store/actions/get';
import type { StoreContext } from '../../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../../shared/helpers/ddb-mock';

/**
 * The same condition on all three adapters: a row whose `s3Key` addresses an
 * object outside the path the row's own identifiers produce. It is a
 * configuration or a tenancy fault — the adapter is pointed at the wrong
 * prefix, or the row was planted — and not a payload that cannot be read, so
 * every adapter must refuse the read rather than return a shorter answer.
 */
const OBJECT_ID = '01J9ZQ5X3N8VQ4M6C2T7R0K1HD';
const PREFIX = 'p/';

/** An offloader that records downloads and refuses a key the row does not own. */
function scopedOffloader(): {
  download: jest.Mock;
  assertOwnedKey: (k: string, s: readonly string[]) => void;
} {
  return {
    download: jest.fn(),
    assertOwnedKey: (key: string, scope: readonly string[]) => assertKeyInScope(key, PREFIX, scope),
  };
}

/** The descriptor a foreign row carries: an S3 payload under someone else's scope. */
function foreignDescriptor(scope: readonly string[]): Record<string, unknown> {
  return {
    location: PayloadLocation.S3,
    serdeType: 'json',
    compressed: false,
    s3Key: buildS3Key(PREFIX, scope, OBJECT_ID),
  };
}

const checkpointerSerde = {
  dumpsTyped: (value: unknown): Promise<[string, Uint8Array]> =>
    Promise.resolve(['json', new TextEncoder().encode(JSON.stringify(value))]),
  loadsTyped: (_type: string, data: Uint8Array | string): Promise<unknown> =>
    Promise.resolve(JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data))),
};

/** `history.getMessages` under the default `'skip'` policy, reading one foreign row. */
async function readHistory(offloader: ReturnType<typeof scopedOffloader>): Promise<unknown> {
  const { client, mock } = createStrictDocumentMock();
  const context: HistoryContext = {
    client,
    tableName: 'history',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    onCorruptMessage: 'skip',
    offloader: offloader as never,
  };
  const [human] = mapChatMessagesToStoredMessages([new HumanMessage('offloaded')]);
  const item = await buildMessageItem({ ...context, offloader: undefined }, 's1', '01A', human);
  item.message = foreignDescriptor(['victim']) as never;
  mock.on(QueryCommand).resolves({ Items: [item] });
  return getMessages(context, 's1');
}

/** `store.getItem`, reading one foreign row. */
async function readStore(offloader: ReturnType<typeof scopedOffloader>): Promise<unknown> {
  const { client, mock } = createStrictDocumentMock();
  const context: StoreContext = {
    client,
    tableName: 'store',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    maxSearchCandidates: 1000,
    maxScanItems: 10000,
    vectorScoreDirection: 'relevance',
    offloader: offloader as never,
  };
  mock.on(GetCommand).resolves({
    Item: {
      PK: 'STORE#users',
      SK: 'u1#profile',
      namespace: ['users', 'u1'],
      key: 'profile',
      createdAt: 'c',
      updatedAt: 'u',
      value: foreignDescriptor(['victims', 'v1', 'secret']),
    },
  });
  return getItem(context, ['users', 'u1'], 'profile');
}

/** `saver.getTuple`, reading one foreign checkpoint payload row. */
async function readCheckpointer(offloader: ReturnType<typeof scopedOffloader>): Promise<unknown> {
  const { client, mock } = createStrictDocumentMock();
  const context: CheckpointerContext = {
    client,
    tableName: 'ckpt',
    serde: checkpointerSerde,
    logger: SILENT_LOGGER,
    offloader: offloader as never,
  };
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
    Item: {
      PK: 'CHKPT#t',
      SK: 'PAYLOAD##ckpt-1',
      checkpoint: foreignDescriptor(['victim', '', 'ckpt-1', 'checkpoint']),
    },
  });
  return getCheckpointTuple(context, { configurable: { thread_id: 't' } });
}

const ADAPTERS: readonly [string, (o: ReturnType<typeof scopedOffloader>) => Promise<unknown>][] = [
  ['history.getMessages', readHistory],
  ['store.getItem', readStore],
  ['saver.getTuple', readCheckpointer],
];

/** What one adapter answered: the branded shape, or the absence of a throw. */
async function answerOf(
  read: (o: ReturnType<typeof scopedOffloader>) => Promise<unknown>,
): Promise<{ code?: string; field?: string; downloads: number }> {
  const offloader = scopedOffloader();
  try {
    await read(offloader);
    return { downloads: offloader.download.mock.calls.length };
  } catch (error) {
    const coded = error as { code?: string; context?: { field?: string } };
    return {
      code: coded.code,
      field: coded.context?.field,
      downloads: offloader.download.mock.calls.length,
    };
  }
}

describe('an out-of-scope s3Key is a refusal, not payload loss (M-03)', () => {
  it.each(ADAPTERS)('%s raises rather than reading past the row', async (_name, read) => {
    expect(await answerOf(read)).toEqual({
      code: ErrorCode.VALIDATION,
      field: 's3Key',
      downloads: 0,
    });
  });

  it('answers alike on all three adapters, so no row shape is skipped on one and raised on another', async () => {
    const answers = await Promise.all(ADAPTERS.map(([, read]) => answerOf(read)));
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });
});
