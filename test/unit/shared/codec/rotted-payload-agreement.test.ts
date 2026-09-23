import { GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { HumanMessage, mapChatMessagesToStoredMessages } from '@langchain/core/messages';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { getCheckpointTuple } from '../../../../src/checkpointer/actions/get-tuple';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import { getMessages } from '../../../../src/history/actions/get-messages';
import { parseSessionId } from '../../../../src/history/internal/parse';
import { buildMessageItem } from '../../../../src/history/internal/rows';
import type { HistoryContext } from '../../../../src/history/internal/setup';
import { loadPayloadValue, PayloadLocation } from '../../../../src/shared/codec/codec';
import { bytesHoldDeclaredForm } from '../../../../src/shared/codec/declared-form';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { isPermanentPayloadLoss } from '../../../../src/shared/codec/payload-loss';
import { DynamoDBLangGraphError } from '../../../../src/shared/errors/base-error';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { getItem } from '../../../../src/store/internal/get-item';
import { parseStoreAddress } from '../../../../src/store/internal/parse';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/**
 * The same condition on all three adapters, under both serializers a caller
 * can end up with: a row whose stored bytes are no longer the form the row
 * declares. Nothing recovers them, so every adapter must say so with the one
 * code a caller quarantines rot on — and which serde the adapter happens to
 * carry must not decide which code that is.
 *
 * It used to. `JSON_SERDE` branded the parse failure itself, so it reached the
 * caller as `PAYLOAD_CORRUPT`; every other serializer, the checkpointer's own
 * default included, threw an unbranded `SyntaxError` that was rebranded as the
 * refusal reserved for bytes that are *intact*. A caller branching on
 * `PAYLOAD_CORRUPT` never matched, and `history.getMessages` lost the whole
 * conversation under the default serializer where it promises one dropped
 * message.
 */
const CONFIGURABLE = { configurable: { thread_id: 't' } };

/** Bytes that are not JSON at all: a row whose payload rotted in place. */
const ROTTED = new TextEncoder().encode('{"role":"hum');

/** The descriptor such a row carries: an inline payload holding those bytes. */
function rottedDescriptor(): Record<string, unknown> {
  return {
    location: PayloadLocation.INLINE,
    serdeType: 'json',
    compressed: false,
    bytes: ROTTED,
  };
}

/**
 * The serializer a saver gets when the caller names none — LangGraph's
 * `JsonPlusSerializer`, taken from a real adapter rather than restated, because
 * the point of the row is what that default does with it.
 */
function defaultSerde(): SerializerProtocol {
  const { client } = createStrictDocumentMock();
  return new DynamoDBSaver({ tableName: 'ckpt', client, logger: SILENT_LOGGER }).serde;
}

/** The two rows `getTuple` reads: a decodable META, and a PAYLOAD that rotted. */
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
    Item: { PK: 'CHKPT#t', SK: 'PAYLOAD##ckpt-1', checkpoint: rottedDescriptor() },
  });
}

/** A history context reading one rotted row and one intact one, under `policy`. */
async function historyReading(
  serde: SerializerProtocol,
  policy: 'skip' | 'throw',
): Promise<{ context: HistoryContext; read: () => Promise<unknown[]> }> {
  const { client, mock } = createStrictDocumentMock();
  const context: HistoryContext = {
    client,
    tableName: 'history',
    serde,
    logger: SILENT_LOGGER,
    ulid: () => 'U',
    onCorruptMessage: policy,
  };
  const [human] = mapChatMessagesToStoredMessages([new HumanMessage('still here')]);
  const rotted = await buildMessageItem(context, {
    sessionId: parseSessionId('s1'),
    messageId: '01A',
    message: human,
  });
  rotted.message = rottedDescriptor() as never;
  const intact = await buildMessageItem(context, {
    sessionId: parseSessionId('s1'),
    messageId: '01B',
    message: human,
  });
  mock.on(QueryCommand).resolves({ Items: [rotted, intact] });
  return { context, read: () => getMessages(context, 's1') };
}

/** `history.getMessages` under `onCorruptMessage: 'throw'`, reading one rotted row. */
async function readHistory(serde: SerializerProtocol): Promise<unknown> {
  return (await historyReading(serde, 'throw')).read();
}

/** `store.getItem`, reading one rotted row. */
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
      value: rottedDescriptor(),
    },
  });
  return getItem(context, parseStoreAddress(['users', 'u1'], 'profile'));
}

/** `saver.getTuple`, reading one rotted checkpoint payload row. */
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

/** The two serializers a row can be read back through. */
const SERDES: readonly [string, () => SerializerProtocol][] = [
  ['JSON_SERDE', () => JSON_SERDE],
  ['the checkpointer default', defaultSerde],
];

/** Every adapter paired with every serde, so the grid is asserted rather than sampled. */
const GRID = ADAPTERS.flatMap(([adapter, read]) =>
  SERDES.map(
    ([serdeName, serde]) =>
      [`${adapter} / ${serdeName}`, read, serde] as [
        string,
        (s: SerializerProtocol) => Promise<unknown>,
        () => SerializerProtocol,
      ],
  ),
);

/** What one adapter answered: the branded shape, or the absence of a throw. */
async function answerOf(
  read: (serde: SerializerProtocol) => Promise<unknown>,
  serde: () => SerializerProtocol,
): Promise<{ name?: string; code?: string; field?: string }> {
  try {
    await read(serde());
    return {};
  } catch (error) {
    const coded = error as { name: string; code?: string; context?: { field?: string } };
    return { name: coded.name, code: coded.code, field: coded.context?.field };
  }
}

describe('bytes that are no longer the form the row declares are payload loss', () => {
  it.each(GRID)('%s reports it as rot rather than as a refusal', async (_name, read, serde) => {
    expect(await answerOf(read, serde)).toEqual({
      name: 'DynamoDBLangGraphError',
      code: ErrorCode.PAYLOAD_CORRUPT,
      field: undefined,
    });
  });

  it('answers alike on every adapter and every serde, so the code never depends on either', async () => {
    const answers = await Promise.all(GRID.map(([, read, serde]) => answerOf(read, serde)));
    expect(new Set(answers.map((answer) => JSON.stringify(answer))).size).toBe(1);
  });

  /**
   * The classification is what the `skip` policy acts on, so getting it wrong
   * cost the whole read rather than the one row: under the checkpointer's own
   * default serializer a single rotted item raised past the policy and took the
   * conversation with it.
   */
  it.each(SERDES)('lets history drop the one rotted message under %s', async (_name, serde) => {
    const { read } = await historyReading(serde(), 'skip');
    await expect(read()).resolves.toHaveLength(1);
  });

  it('is permanent loss, which is what lets the policy confine it to one message', () => {
    expect(
      isPermanentPayloadLoss(new DynamoDBLangGraphError('rot', ErrorCode.PAYLOAD_CORRUPT)),
    ).toBe(true);
  });
});

describe('bytesHoldDeclaredForm', () => {
  it('answers for the declared form, not for what the serde did about it', () => {
    expect(bytesHoldDeclaredForm('json', new TextEncoder().encode('{"a":1}'))).toBe(true);
    expect(bytesHoldDeclaredForm('json', ROTTED)).toBe(false);
    expect(bytesHoldDeclaredForm('json', new Uint8Array())).toBe(false);
  });

  /**
   * A row stores whatever its writer stored, and this runs inside the `catch`
   * that is already reporting a failure, so nothing it is handed may raise.
   */
  it('answers rather than throwing for bytes that are not bytes at all', () => {
    expect(bytesHoldDeclaredForm('json', null as never)).toBe(false);
    expect(bytesHoldDeclaredForm('json', 7 as never)).toBe(false);
  });

  /**
   * A caller's serde may declare any type, and this package has no grammar for
   * one it did not write. Guessing would drop a payload on its own ignorance,
   * so the bytes are taken as intact and the serde's refusal is reported.
   */
  it('takes a type it has no grammar for at its word', () => {
    expect(bytesHoldDeclaredForm('msgpack', ROTTED)).toBe(true);
  });
});

describe('loadPayloadValue', () => {
  const rotted = new TextEncoder().encode('{not json');

  /**
   * The declared form reaches the same verdict under either serializer. The
   * checkpointer's default throws `Unknown serialization type` unbranded and
   * the classifier takes the type at its word; `JSON_SERDE` refuses the form
   * itself, branded the same way, and this passes that refusal through. They
   * disagreed: `JSON_SERDE` read the declared type not at all, so its own
   * `JSON.parse` failure arrived here already branded `PAYLOAD_CORRUPT` and the
   * classifier never ran — which is a row reported on one adapter and dropped
   * on another, for no reason but how the adapter was configured.
   */
  it.each(SERDES)('reports a form %s has no grammar for as a refusal', async (_name, serde) => {
    await expect(loadPayloadValue('x-msgpack', rotted, { serde: serde() })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'serde' },
    });
  });

  /**
   * The refusal of a serde whose format this package cannot check reaches the
   * caller intact, because a payload that merely cannot be checked is not a
   * payload that is known to be gone.
   */
  it('reports a refusal of an uncheckable format rather than writing the payload off', async () => {
    const serde = {
      dumpsTyped: JSON_SERDE.dumpsTyped,
      loadsTyped: (): Promise<never> => {
        throw new SyntaxError('unexpected byte');
      },
    };
    await expect(loadPayloadValue('msgpack', rotted, { serde })).rejects.toMatchObject({
      code: ErrorCode.VALIDATION,
      context: { field: 'serde' },
    });
  });

  /** A serde is a caller's object: the bytes decide the code, not what it threw. */
  it('reports rot even for a serde that refuses with something that is not an error', async () => {
    const serde = {
      dumpsTyped: JSON_SERDE.dumpsTyped,
      loadsTyped: (): Promise<never> => {
        throw 'refused';
      },
    };
    const error = await loadPayloadValue('json', rotted, { serde }).catch(
      (raised: Error) => raised,
    );
    expect(error).toMatchObject({ code: ErrorCode.PAYLOAD_CORRUPT });
    expect((error as { cause?: Error }).cause).toBeDefined();
  });
});
