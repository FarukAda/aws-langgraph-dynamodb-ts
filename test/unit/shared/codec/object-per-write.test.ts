import { GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

import { putCheckpoint } from '../../../../src/checkpointer/actions/put';
import { putWrites } from '../../../../src/checkpointer/actions/put-writes';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { JSON_SERDE } from '../../../../src/shared/codec/json-serde';
import { buildS3Key } from '../../../../src/shared/codec/s3/config';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { putItem } from '../../../../src/store/actions/put';
import type { StoreContext } from '../../../../src/store/internal/setup';
import { createStrictDocumentMock, resolveRowWrites } from '../../../shared/helpers/ddb-mock';

/**
 * An offloader that builds real keys and records every key it is asked to
 * upload to, so a test can compare the objects two calls address.
 */
function recordingOffloader() {
  const uploaded: string[] = [];
  const offloader = {
    shouldOffload: () => true,
    buildKey: (parts: readonly string[], objectId: string) => buildS3Key('p/', parts, objectId),
    upload: async (key: string) => {
      uploaded.push(key);
      return key;
    },
    deleteBatch: async () => [],
    ownsKey: () => true,
  };
  return { uploaded, offloader };
}

/** The keys the second of two identical calls uploads to, beside the first's. */
async function twoCalls(call: () => Promise<unknown>, uploaded: string[]) {
  await call();
  const first = [...uploaded];
  uploaded.length = 0;
  await call();
  return { first, second: [...uploaded] };
}

/** Both calls uploaded, as many objects each, and not one key in common. */
function expectDisjoint({ first, second }: { first: string[]; second: string[] }): void {
  expect(first.length).toBeGreaterThan(0);
  expect(second).toHaveLength(first.length);
  expect(second.filter((key) => first.includes(key))).toEqual([]);
}

/**
 * Every write call uploads under an id of its own, so two calls writing
 * identical bytes for the same row never address one object. That is what lets
 * one call's cleanup delete an object without asking whether another call's
 * row names it.
 */
describe('each write call uploads to its own objects, even for identical bytes', () => {
  it('two store.put calls of one value to one item', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    resolveRowWrites(mock);
    const { uploaded, offloader } = recordingOffloader();
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
    const op = { namespace: ['users', 'u1'], key: 'profile', value: { name: 'Faruk' } };

    expectDisjoint(await twoCalls(() => putItem(context, op), uploaded));
  });

  it('two saver.put calls of one checkpoint', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(TransactWriteCommand).resolves({});
    const { uploaded, offloader } = recordingOffloader();
    const context = checkpointerContext(client, offloader);
    const checkpoint: Checkpoint = {
      v: 4,
      id: 'ckpt-1',
      ts: '2024-01-01T00:00:00.000Z',
      channel_values: { messages: ['hello'] },
      channel_versions: {},
      versions_seen: {},
    };
    const metadata: CheckpointMetadata = { source: 'loop', step: 0, parents: {} };
    const config = { configurable: { thread_id: 't1' } };

    expectDisjoint(
      await twoCalls(() => putCheckpoint(context, config, checkpoint, metadata), uploaded),
    );
  });

  it.each([
    ['a special', '__interrupt__'],
    ['a regular', 'messages'],
  ])('two putWrites calls of %s write', async (_kind, channel) => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({});
    mock.on(PutCommand).resolves({});
    const { uploaded, offloader } = recordingOffloader();
    const context = checkpointerContext(client, offloader);
    const config = { configurable: { thread_id: 't1', checkpoint_id: 'ckpt-1' } };

    expectDisjoint(
      await twoCalls(
        () => putWrites(context, config, [[channel, { text: 'v' }]], 'task-1'),
        uploaded,
      ),
    );
  });
});

function checkpointerContext(
  client: CheckpointerContext['client'],
  offloader: ReturnType<typeof recordingOffloader>['offloader'],
): CheckpointerContext {
  return {
    client,
    tableName: 'ckpt',
    serde: JSON_SERDE,
    logger: SILENT_LOGGER,
    offloader: offloader as never,
  };
}
