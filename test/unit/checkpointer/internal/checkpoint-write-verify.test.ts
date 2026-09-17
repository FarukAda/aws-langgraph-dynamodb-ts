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
  mock.on(GetCommand).callsFake(async (input: { Key: { SK: string } }) => {
    const answer = input.Key.SK.startsWith('META#') ? meta : payload;
    if (answer === 'fails') {
      throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    }
    return answer;
  });
}

describe('verifyCheckpointLanded', () => {
  /** A landing releases nothing, so it hands back nothing live. */
  it("reports landed when the META row holds this attempt's metadata key, reading both rows' descriptors", async () => {
    const { client, mock } = createStrictDocumentMock();
    answerBySortKey(mock, metaAt('k/meta/A'), ckptAt('k/ckpt/A'));
    const { meta, payload } = rows(s3('k/meta/A'), s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
      verdict: 'landed',
      live: [],
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
    answerBySortKey(mock, metaAt(), ckptAt('k/ckpt/A'));
    const { meta, payload } = rows(inline, s3('k/ckpt/A'));
    await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
      verdict: 'landed',
      live: [],
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

  /**
   * Only a release needs both rows. The probed row alone proves a landing,
   * which releases nothing. A non-commit licenses a release, and the row that
   * was not read may name the very object it would release. A failed probed
   * read establishes nothing at all.
   */
  it.each([
    ['the probed META read fails', 'unverified', s3('k/meta/A'), 'fails', ckptAt('k/ckpt/A')],
    ['the probed PAYLOAD read fails', 'unverified', inline, metaAt(), 'fails'],
    [
      'META proves the landing and the PAYLOAD read fails',
      'landed',
      s3('k/meta/A'),
      metaAt('k/meta/A'),
      'fails',
    ],
    [
      'PAYLOAD proves the landing and the META read fails',
      'landed',
      inline,
      'fails',
      ckptAt('k/ckpt/A'),
    ],
    [
      'META shows another writer and the PAYLOAD read fails',
      'unverified',
      s3('k/meta/A'),
      metaAt('k/meta/OTHER'),
      'fails',
    ],
    [
      'PAYLOAD shows another writer and the META read fails',
      'unverified',
      inline,
      'fails',
      ckptAt('k/ckpt/OTHER'),
    ],
  ] as const)(
    'when %s, reports %s with nothing live',
    async (_case, verdict, metadata, metaAnswer, payloadAnswer) => {
      const { client, mock } = createStrictDocumentMock();
      answerBySortKey(mock, metaAnswer, payloadAnswer);
      const { meta, payload } = rows(metadata, s3('k/ckpt/A'));
      await expect(verifyCheckpointLanded(context(client), meta, payload)).resolves.toEqual({
        verdict,
        live: [],
      });
      expect(mock.commandCalls(GetCommand)).toHaveLength(2);
    },
  );
});
