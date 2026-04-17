import {
  DynamoDBDocument,
  DynamoDBDocumentClientResolvedConfig,
  ServiceInputTypes,
  ServiceOutputTypes,
} from '@aws-sdk/lib-dynamodb';
import { AwsStub } from 'aws-sdk-client-mock';

import { deleteThreadAction } from '../../../src/checkpointer/actions';
import { createMockCheckpointItem, createMockWriteItem } from '../../shared/fixtures/test-data';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';

describe('deleteThreadAction', () => {
  let ddbDocMock: AwsStub<
    ServiceInputTypes,
    ServiceOutputTypes,
    DynamoDBDocumentClientResolvedConfig
  >;
  let client: DynamoDBDocument;

  beforeEach(() => {
    const mockClients = createMockDynamoDBClient();
    ddbDocMock = mockClients.ddbDocMock;
    client = mockClients.client;
  });

  afterEach(() => {
    ddbDocMock.reset();
  });

  it('should delete thread with checkpoints and writes', async () => {
    const checkpoints = [
      createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns'),
      createMockCheckpointItem('thread-123', 'checkpoint-2', 'ns'),
    ];

    const writes = [createMockWriteItem('thread-123', 'checkpoint-1', 'ns', 'task-1', 0)];

    // Mock checkpoint query
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: checkpoints,
      LastEvaluatedKey: undefined,
    });

    // Mock all subsequent operations (batch writes and queries)
    ddbDocMock.onAnyCommand().resolves({
      Items: writes,
    });

    await deleteThreadAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      threadId: 'thread-123',
    });

    expect(ddbDocMock.calls()).toHaveLength(5);
  });

  it('should handle pagination for many checkpoints', async () => {
    const batch1 = Array(50)
      .fill(null)
      .map((_, i) => createMockCheckpointItem('thread-123', `checkpoint-${i}`, 'ns'));
    const batch2 = Array(30)
      .fill(null)
      .map((_, i) => createMockCheckpointItem('thread-123', `checkpoint-${i + 50}`, 'ns'));

    // First query with pagination
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: batch1,
      LastEvaluatedKey: { thread_id: 'thread-123', checkpoint_id: 'checkpoint-49' },
    });

    // Second query
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: batch2,
      LastEvaluatedKey: undefined,
    });

    // Mock checkpoint batch writes (4 batches: 25+25+25+5)
    ddbDocMock.onAnyCommand().resolves({});

    await deleteThreadAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      threadId: 'thread-123',
    });

    expect(ddbDocMock.calls().length).toBeGreaterThan(6); // 2 queries + multiple batch writes
  });

  it('should handle empty thread', async () => {
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [],
      LastEvaluatedKey: undefined,
    });

    await deleteThreadAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      threadId: 'thread-123',
    });

    expect(ddbDocMock.calls()).toHaveLength(1); // Only query, no deletes
  });

  it('should throw error for invalid thread_id', async () => {
    await expect(
      deleteThreadAction({
        client,
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        threadId: '',
      }),
    ).rejects.toThrow('thread_id cannot be empty');
  });

  it('should throw when exceeding max delete batch size during infinite pagination', async () => {
    // Return a large-enough page on each call so the total-item cap trips before
    // the iteration cap; covers the safety path that protects against runaway pagination.
    const bigPage = Array(1000)
      .fill(null)
      .map((_, i) => createMockCheckpointItem('thread-123', `checkpoint-p-${i}`, 'ns'));
    ddbDocMock.onAnyCommand().resolves({
      Items: bigPage,
      LastEvaluatedKey: { thread_id: 'thread-123', checkpoint_id: 'checkpoint-p-last' },
    });

    await expect(
      deleteThreadAction({
        client,
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        threadId: 'thread-123',
      }),
    ).rejects.toThrow('Thread has too many items');
  });

  it('should throw error when exceeding max delete batch size', async () => {
    // Cap is 100k; an inline array of that size would slow the test suite, so we
    // return 50k per page across two pages to hit the threshold cleanly.
    const page = Array(50_001)
      .fill(null)
      .map((_, i) => createMockCheckpointItem('thread-123', `checkpoint-${i}`, 'ns'));

    ddbDocMock
      .onAnyCommand()
      .resolvesOnce({
        Items: page,
        LastEvaluatedKey: { thread_id: 'thread-123', checkpoint_id: 'checkpoint-50000' },
      })
      .resolvesOnce({
        Items: page,
        LastEvaluatedKey: undefined,
      });

    await expect(
      deleteThreadAction({
        client,
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        threadId: 'thread-123',
      }),
    ).rejects.toThrow('Thread has too many items');
  });

  it('should delete checkpoints in batches of 25', async () => {
    const checkpoints = Array(60)
      .fill(null)
      .map((_, i) => createMockCheckpointItem('thread-123', `checkpoint-${i}`, 'ns'));

    // Mock checkpoint query
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: checkpoints,
      LastEvaluatedKey: undefined,
    });

    // Mock 3 checkpoint batch writes (25+25+10)
    ddbDocMock.onAnyCommand().resolves({});

    await deleteThreadAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      threadId: 'thread-123',
    });

    // Should have: 1 query + 3 batch writes + 60 write queries + possible write batch writes
    const calls = ddbDocMock.calls();
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });

  it('should handle checkpoints with multiple writes', async () => {
    const checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns')];

    const writes = Array(30)
      .fill(null)
      .map((_, i) => createMockWriteItem('thread-123', 'checkpoint-1', 'ns', 'task-1', i));

    // Chain all mock responses in order on a single handler
    ddbDocMock
      .onAnyCommand()
      .resolvesOnce({ Items: checkpoints, LastEvaluatedKey: undefined }) // checkpoint query
      .resolvesOnce({}) // checkpoint batch delete
      .resolvesOnce({ Items: writes }) // writes query
      .resolves({}); // writes batch deletes (25+5)

    await deleteThreadAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      threadId: 'thread-123',
    });

    expect(ddbDocMock.calls().length).toBeGreaterThanOrEqual(4);
  });

  it('should throw error for thread_id with separator', async () => {
    await expect(
      deleteThreadAction({
        client,
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        threadId: 'thread:::123',
      }),
    ).rejects.toThrow('thread_id cannot contain separator');
  });

  it('should throw error for thread_id with control characters', async () => {
    await expect(
      deleteThreadAction({
        client,
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        threadId: 'thread\x00id',
      }),
    ).rejects.toThrow('thread_id cannot contain control characters');
  });

  it('should handle checkpoints without writes', async () => {
    const checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns')];

    // Mock checkpoint query
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: checkpoints,
      LastEvaluatedKey: undefined,
    });

    // Mock all subsequent operations
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    await deleteThreadAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      threadId: 'thread-123',
    });

    expect(ddbDocMock.calls()).toHaveLength(3);
  });

  it('should handle DynamoDB errors with retry', async () => {
    const checkpoints = [createMockCheckpointItem('thread-123', 'checkpoint-1', 'ns')];

    // First attempt fails, second succeeds
    ddbDocMock.onAnyCommand().rejectsOnce({ name: 'ThrottlingException' });
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: checkpoints,
      LastEvaluatedKey: undefined,
    });

    // Mock subsequent operations
    ddbDocMock.onAnyCommand().resolves({});

    await deleteThreadAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      threadId: 'thread-123',
    });

    expect(ddbDocMock.calls().length).toBeGreaterThanOrEqual(3);
  });
});
