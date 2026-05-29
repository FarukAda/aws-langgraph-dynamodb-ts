import { GetCommand } from '@aws-sdk/lib-dynamodb';

import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

describe('createStrictDocumentMock', () => {
  it('rejects any command that was not explicitly stubbed', async () => {
    const { client, mock } = createStrictDocumentMock();
    mock.on(GetCommand).resolves({ Item: { pk: 'a' } });

    await expect(client.get({ TableName: 't', Key: { pk: 'a' } })).resolves.toEqual({
      Item: { pk: 'a' },
    });
    await expect(client.put({ TableName: 't', Item: { pk: 'b' } })).rejects.toThrow(
      /unstubbed command/,
    );
  });
});
