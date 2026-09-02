import { GetCommand } from '@aws-sdk/lib-dynamodb';
import type { Checkpoint } from '@langchain/langgraph-checkpoint';

import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import {
  coversEveryChannel,
  readParentStoredChannels,
  selectStoredChannels,
  storedChannelsFor,
  withStoredChannels,
} from '../../../../src/checkpointer/internal/stored-channels';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

const serde = {
  dumpsTyped: async (value: unknown): Promise<[string, Uint8Array]> => [
    'json',
    new TextEncoder().encode(JSON.stringify(value)),
  ],
  loadsTyped: async (_t: string, d: Uint8Array | string): Promise<unknown> =>
    JSON.parse(typeof d === 'string' ? d : new TextDecoder().decode(d)),
};

function context(client: CheckpointerContext['client']): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER };
}

const checkpoint: Checkpoint = {
  v: 4,
  id: 'c1',
  ts: '2024-01-01T00:00:00.000Z',
  channel_values: { messages: ['hi'], stepCount: 3 },
  channel_versions: { messages: 1, stepCount: 2 },
  versions_seen: {},
};

describe('selectStoredChannels (validation suite: only changed channels are stored)', () => {
  it('stores every value when the put carries no newVersions', () => {
    expect(selectStoredChannels(checkpoint, undefined, [])).toEqual(['messages', 'stepCount']);
  });

  it('stores only the channels newVersions names when nothing was stored before', () => {
    expect(selectStoredChannels(checkpoint, { stepCount: 2 }, [])).toEqual(['stepCount']);
    expect(selectStoredChannels(checkpoint, {}, [])).toEqual([]);
  });

  it('carries over a channel the parent stored and the put still holds a value for', () => {
    expect(selectStoredChannels(checkpoint, { stepCount: 2 }, ['messages'])).toEqual([
      'messages',
      'stepCount',
    ]);
    expect(selectStoredChannels(checkpoint, { stepCount: 2 }, ['other'])).toEqual(['stepCount']);
  });

  it('keeps every value when the parent row predates the attribute', () => {
    expect(selectStoredChannels(checkpoint, { stepCount: 2 }, undefined)).toEqual([
      'messages',
      'stepCount',
    ]);
  });
});

describe('withStoredChannels / coversEveryChannel', () => {
  it('narrows channel_values to the stored channels and leaves the versions intact', () => {
    const stored = withStoredChannels(checkpoint, ['stepCount']);
    expect(stored.channel_values).toEqual({ stepCount: 3 });
    expect(stored.channel_versions).toEqual(checkpoint.channel_versions);
    expect(checkpoint.channel_values).toEqual({ messages: ['hi'], stepCount: 3 });
  });

  it('reports whether newVersions already names every value the put carries', () => {
    expect(coversEveryChannel(checkpoint, { messages: 1, stepCount: 2 })).toBe(true);
    expect(coversEveryChannel(checkpoint, { stepCount: 2 })).toBe(false);
  });
});

describe('readParentStoredChannels', () => {
  it('reads only the storedChannels attribute of the parent META row, consistently', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { storedChannels: ['messages'] } });
    await expect(readParentStoredChannels(context(client), 't', '', 'p1')).resolves.toEqual([
      'messages',
    ]);
    const input = mock.commandCalls(GetCommand)[0].args[0].input;
    expect(input.Key).toEqual({ PK: 'CHKPT#t', SK: 'META##p1' });
    expect(input.ProjectionExpression).toBe('#sc');
    expect(input.ConsistentRead).toBe(true);
  });

  it('returns undefined for a missing parent or one without the attribute', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock
      .on(GetCommand)
      .resolvesOnce({})
      .resolves({ Item: { threadId: 't' } });
    await expect(readParentStoredChannels(context(client), 't', '', 'p1')).resolves.toBeUndefined();
    await expect(readParentStoredChannels(context(client), 't', '', 'p1')).resolves.toBeUndefined();
  });
});

describe('storedChannelsFor', () => {
  it('never reads the parent when newVersions is absent, there is no parent, or it covers every value', async () => {
    const { client, mock } = createStrictDocumentMock();
    await expect(
      storedChannelsFor(context(client), 't', '', checkpoint, undefined, 'p1'),
    ).resolves.toEqual(['messages', 'stepCount']);
    await expect(
      storedChannelsFor(context(client), 't', '', checkpoint, { stepCount: 2 }, undefined),
    ).resolves.toEqual(['stepCount']);
    await expect(
      storedChannelsFor(context(client), 't', '', checkpoint, { messages: 1, stepCount: 2 }, 'p1'),
    ).resolves.toEqual(['messages', 'stepCount']);
    expect(mock.commandCalls(GetCommand)).toHaveLength(0);
  });

  it('reads the parent to carry its stored channels forward', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { storedChannels: ['messages'] } });
    await expect(
      storedChannelsFor(context(client), 't', '', checkpoint, { stepCount: 2 }, 'p1'),
    ).resolves.toEqual(['messages', 'stepCount']);
  });
});
