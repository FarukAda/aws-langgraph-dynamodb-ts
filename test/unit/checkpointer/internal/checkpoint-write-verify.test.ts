import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { verifyCheckpointLanded } from '../../../../src/checkpointer/internal/checkpoint-write-verify';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import type { CheckpointMetaItem, CheckpointPayloadItem } from '../../../../src/checkpointer/types';
import { type PayloadDescriptor, PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (): Promise<[string, Uint8Array]> => ['json', new Uint8Array()],
  loadsTyped: async (): Promise<unknown> => ({}),
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

/** Answer the META and PAYLOAD reads separately, by the sort key each one names. */
function answerBySortKey(
  mock: ReturnType<typeof createStrictDocumentMock>['mock'],
  meta: Answer,
  payload: Answer,
): void {
  mock.on(GetCommand).callsFake(async (input: { Key: { SK: string } }) => {
    const answer = input.Key.SK.startsWith('META#') ? meta : payload;
    if (answer === 'fails') {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    }
    return answer;
  });
}

describe('verifyCheckpointLanded', () => {
  it("reports landed when the META row holds this attempt's metadata key, reading both rows' descriptors", async () => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(
      mock,
      { Item: { metadata: ref('k/meta/A') } },
      { Item: { checkpoint: ref('k/ckpt/A') } },
    );
    const { meta, payload } = rows(s3('k/meta/A'), s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
      verdict: 'landed',
      live: [ref('k/meta/A'), ref('k/ckpt/A')],
    });
    const inputs = mock.commandCalls(GetCommand).map((call) => call.args[0].input);
    expect(inputs.map((input) => input.Key)).toEqual([
      { PK: 'CHKPT#t', SK: 'META##c1' },
      { PK: 'CHKPT#t', SK: 'PAYLOAD##c1' },
    ]);
    expect(inputs.every((input) => input.ConsistentRead === true)).toBe(true);
    expect(inputs.map((input) => input.ProjectionExpression)).toEqual([
      '#d0.#loc, #d0.#s3k',
      '#d0.#loc, #d0.#s3k',
    ]);
    expect(inputs.map((input) => input.ExpressionAttributeNames!['#d0'])).toEqual([
      'metadata',
      'checkpoint',
    ]);
  });

  it('probes the PAYLOAD row when only the checkpoint is offloaded', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(mock, { Item: { metadata: ref() } }, { Item: { checkpoint: ref('k/ckpt/A') } });
    const { meta, payload } = rows(inline, s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
      verdict: 'landed',
      live: [ref(), ref('k/ckpt/A')],
    });
  });

  it('reports not-landed, with nothing live, when both rows are absent', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(mock, {}, {});
    const { meta, payload } = rows(s3('k/meta/A'), inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
      verdict: 'not-landed',
      live: [],
    });
  });

  /**
   * Another writer's rows decide the verdict, and every descriptor they hold is
   * handed back: identical checkpoint bytes under the same id share this
   * attempt's checkpoint key even when the metadata differs (C-02c).
   */
  it("reports not-landed when the row holds another attempt's key, with what both rows hold", async () => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(
      mock,
      { Item: { metadata: ref('k/meta/OTHER') } },
      { Item: { checkpoint: ref('k/ckpt/A') } },
    );
    const { meta, payload } = rows(s3('k/meta/A'), s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
      verdict: 'not-landed',
      live: [ref('k/meta/OTHER'), ref('k/ckpt/A')],
    });
  });

  it('reports not-landed when the row holds an inline descriptor', async () => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(mock, { Item: { metadata: ref() } }, {});
    const { meta, payload } = rows(s3('k/meta/A'), inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
      verdict: 'not-landed',
      live: [ref()],
    });
  });

  it('reports not-landed without reading when nothing was offloaded (nothing to clean up)', async () => {
    const { client, mock } = createStrictDocumentMock();
    const { meta, payload } = rows(inline, inline);
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
      verdict: 'not-landed',
      live: [],
    });
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  /** One row read is not enough to release anything: the other may name the same object. */
  it.each([
    ['META', 'fails', { Item: { checkpoint: ref('k/ckpt/A') } }],
    ['PAYLOAD', { Item: { metadata: ref('k/meta/OTHER') } }, 'fails'],
  ] as const)(
    'reports unverified, with nothing live, when the %s read fails',
    async (_row, metaAnswer, payloadAnswer) => {
      const { client, mock } = createStrictDocumentMock();
      answerBySortKey(mock, metaAnswer, payloadAnswer);
      const { meta, payload } = rows(s3('k/meta/A'), s3('k/ckpt/A'));
      await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
        verdict: 'unverified',
        live: [],
      });
    },
  );
});
