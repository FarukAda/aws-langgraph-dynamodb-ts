import { QueryCommand } from '@aws-sdk/lib-dynamodb';

import { fetchTargetMeta } from '../../../../src/checkpointer/internal/read';
import type { CheckpointerContext } from '../../../../src/checkpointer/internal/setup';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';
import { threadAddress } from '../../../shared/helpers/parsed-inputs';

const serde = {
  dumpsTyped: (): Promise<[string, Uint8Array]> => Promise.resolve(['json', new Uint8Array()]),
  loadsTyped: (): Promise<unknown> => Promise.resolve({}),
};

function context(
  client: CheckpointerContext['client'],
  ttl?: CheckpointerContext['ttl'],
): CheckpointerContext {
  return { client, tableName: 'ckpt', serde, logger: SILENT_LOGGER, ...(ttl ? { ttl } : {}) };
}

describe('the newest-META read sizes its page by whether a row can have expired', () => {
  it('reads one row per page when the adapter has no ttl', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await fetchTargetMeta(context(client), threadAddress('t1', ''));
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.Limit).toBe(1);
  });

  it('reads fifty per page with a ttl, to step over rows that aged out', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(QueryCommand).resolves({ Items: [] });
    await fetchTargetMeta(context(client, { days: 1 }), threadAddress('t1', ''));
    expect(mock.commandCalls(QueryCommand)[0].args[0].input.Limit).toBe(50);
  });
});
