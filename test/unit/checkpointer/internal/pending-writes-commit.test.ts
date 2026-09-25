import { PutCommand } from '@aws-sdk/lib-dynamodb';

import { parseThreadId } from '../../../../src/checkpointer/internal/parse';
import { commitPendingWrites } from '../../../../src/checkpointer/internal/pending-writes';
import type { CheckpointWriteRow } from '../../../../src/checkpointer/internal/rows';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: (): Promise<[string, Uint8Array]> => Promise.resolve(['json', new Uint8Array()]),
  loadsTyped: (): Promise<unknown> => Promise.resolve({}),
};

const row = (index: number, channel: string): CheckpointWriteRow => ({
  PK: 'CHKPT#t',
  SK: `WRITE#ns#c1#task#${index}#${channel}`,
  taskId: 'task',
  index,
  channel,
  writeGroup: 'g1',
  value: {
    location: PayloadLocation.INLINE,
    bytes: new Uint8Array([1]),
    serdeType: 'json',
    compressed: false,
  },
});

describe('commitPendingWrites', () => {
  it('commits a positional write first-write-wins and a special one as an overwrite', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(PutCommand).resolves({});
    const context: CheckpointerContext = { client, tableName: 't', serde, logger: SILENT_LOGGER };

    await commitPendingWrites(context, {
      threadId: parseThreadId('t'),
      items: [row(0, 'a'), row(-1, '__error__')],
      signal: undefined,
    });

    const conditions = mock
      .commandCalls(PutCommand)
      .map((call) => [call.args[0].input.Item?.channel, call.args[0].input.ConditionExpression]);
    expect(conditions).toEqual(
      expect.arrayContaining([
        ['a', 'attribute_not_exists(PK)'],
        ['__error__', undefined],
      ]),
    );
  });
});
