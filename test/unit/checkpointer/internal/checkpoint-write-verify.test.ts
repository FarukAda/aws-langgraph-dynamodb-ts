import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { verifyCheckpointLanded } from '../../../../src/checkpointer/internal/checkpoint-write-verify';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointMetaItem, CheckpointPayloadItem } from '../../../../src/checkpointer/types';
import { type PayloadDescriptor, PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (): Promise<[string, Uint8Array]> =>
    await Promise.resolve(['json', new Uint8Array()]),
  loadsTyped: async (): Promise<unknown> => await Promise.resolve({}),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

const inline: PayloadDescriptor = {
  location: PayloadLocation.INLINE,
  serdeType: 'json',
  compressed: false,
  bytes: new Uint8Array([1]),
};

function s3(s3Key: string): PayloadDescriptor {
  return { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key };
}

/** A descriptor as the verification reads project it: its location and key only. */
function ref(s3Key?: string) {
  return s3Key === undefined
    ? { location: PayloadLocation.INLINE }
    : { location: PayloadLocation.S3, s3Key };
}

function rows(metadata: PayloadDescriptor, checkpoint: PayloadDescriptor) {
  const meta: CheckpointMetaItem = {
    PK: 'CHKPT#t',
    SK: 'META##c1',
    threadId: 't',
    checkpointNs: '',
    checkpointId: 'c1',
    metadata,
  };
  const payload: CheckpointPayloadItem = { PK: 'CHKPT#t', SK: 'PAYLOAD##c1', checkpoint };
  return { meta, payload };
}

/** What one verification read answers: a result, or a failure. */
type Answer = { Item?: Record<string, object> } | 'fails';

/** A META row holding metadata at `s3Key`, or inline metadata without one. */
const metaAt = (s3Key?: string) => ({ Item: { metadata: ref(s3Key) } });

/** A PAYLOAD row holding a checkpoint at `s3Key`. */
const ckptAt = (s3Key: string) => ({ Item: { checkpoint: ref(s3Key) } });

/** Answer the META and PAYLOAD reads separately, by the sort key each one names. */
function answerBySortKey(
  mock: ReturnType<typeof createStrictDocumentMock>['mock'],
  meta: Answer,
  payload: Answer,
): void {
  mock.on(GetCommand).callsFake((input: { Key: { SK: string } }) => {
    const answer = input.Key.SK.startsWith('META#') ? meta : payload;
    if (answer === 'fails') {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    }
    return answer;
  });
}

/** The reads a verification issued, as their inputs. */
function readInputs(mock: ReturnType<typeof createStrictDocumentMock>['mock']) {
  return mock.commandCalls(GetCommand).map((call) => call.args[0].input);
}

describe('verifyCheckpointLanded', () => {
  /**
   * The rows commit together, so the row carrying an offloaded descriptor
   * decides the landing alone, and only its descriptor's location and key are
   * read.
   */
  it("reports landed when the META row holds this attempt's metadata key, reading that row alone", async () => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(mock, metaAt('k/meta/A'), 'fails');
    const { meta, payload } = rows(s3('k/meta/A'), s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe('landed');
    const inputs = readInputs(mock);
    expect(inputs.map((input) => input.Key)).toEqual([{ PK: 'CHKPT#t', SK: 'META##c1' }]);
    expect(inputs[0].ConsistentRead).toBe(true);
    expect(inputs[0].ProjectionExpression).toBe('#d0.#loc, #d0.#s3k');
    expect(inputs[0].ExpressionAttributeNames).toEqual({
      '#d0': 'metadata',
      '#loc': 'location',
      '#s3k': 's3Key',
    });
  });

  it('probes the PAYLOAD row alone when only the checkpoint is offloaded', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(mock, 'fails', ckptAt('k/ckpt/A'));
    const { meta, payload } = rows(inline, s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe('landed');
    const inputs = readInputs(mock);
    expect(inputs.map((input) => input.Key)).toEqual([{ PK: 'CHKPT#t', SK: 'PAYLOAD##c1' }]);
    expect(inputs[0].ExpressionAttributeNames!['#d0']).toBe('checkpoint');
  });

  /**
   * Every put draws its own object id, so a row holding another key, or an
   * inline value, or no row at all, was not written by this attempt, and names
   * none of its uploads. The other row is not read: whatever it holds was
   * committed with the probed one.
   */
  it.each([
    ['is absent', {}],
    ["holds another put's key", metaAt('k/meta/OTHER')],
    ['holds an inline descriptor', metaAt()],
  ] as const)('reports not-landed, reading one row, when the probed row %s', async (_c, answer) => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(mock, answer, 'fails');
    const { meta, payload } = rows(s3('k/meta/A'), s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe(
      'not-landed',
    );
    expect(readInputs(mock)).toHaveLength(1);
  });

  it('reports not-landed without reading when nothing was offloaded (nothing to clean up)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const { meta, payload } = rows(inline, inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe(
      'not-landed',
    );
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  /** A failed read establishes nothing, so nothing may be released on its strength. */
  it.each([
    ['META', s3('k/meta/A')],
    ['PAYLOAD', inline],
  ] as const)('reports unverified when the probed %s read fails', async (_row, metadata) => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(mock, 'fails', 'fails');
    const { meta, payload } = rows(metadata, s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toBe(
      'unverified',
    );
    expect(readInputs(mock)).toHaveLength(1);
  });
});
