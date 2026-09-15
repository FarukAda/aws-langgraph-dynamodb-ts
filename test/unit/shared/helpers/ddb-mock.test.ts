import { DynamoDBDocument, GetCommand } from '@aws-sdk/lib-dynamodb';

import { createStrictDocumentMock, fakeMiddlewareStack } from '../../../shared/helpers/ddb-mock';

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

describe('fakeMiddlewareStack', () => {
  const doubleWith = (middlewareStack: unknown) =>
    ({ destroy: jest.fn(), config: {}, middlewareStack, send: jest.fn() }) as never;

  it('keeps DynamoDBDocument.from silent, and stays load-bearing while the SDK checks', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      DynamoDBDocument.from(doubleWith({}));
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('incompatible version'));

      warn.mockClear();
      DynamoDBDocument.from(doubleWith(fakeMiddlewareStack()));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('clones and concats to itself, as a real stack does', () => {
    const stack = fakeMiddlewareStack();
    expect(stack.clone()).toBe(stack);
    expect(stack.concat()).toBe(stack);
  });
});
