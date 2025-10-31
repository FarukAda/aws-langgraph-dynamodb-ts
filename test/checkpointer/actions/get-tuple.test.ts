import { getTupleAction } from '../../../src/checkpointer/actions';
import { createMockDynamoDBClient } from '../../shared/mocks/dynamodb-mock';
import {
  createMockCheckpointItem,
  createMockWriteItem,
  createMockRunnableConfig,
  createMockSerde,
} from '../../shared/fixtures/test-data';
import { AwsStub } from 'aws-sdk-client-mock';
import {
  DynamoDBDocument,
  DynamoDBDocumentClientResolvedConfig,
  ServiceInputTypes,
  ServiceOutputTypes,
} from '@aws-sdk/lib-dynamodb';

describe('getTupleAction', () => {
  let ddbDocMock: AwsStub<
    ServiceInputTypes,
    ServiceOutputTypes,
    DynamoDBDocumentClientResolvedConfig
  >;
  let client: DynamoDBDocument;
  let serde: any;

  beforeEach(() => {
    const mockClients = createMockDynamoDBClient();
    ddbDocMock = mockClients.ddbDocMock;
    client = mockClients.client;
    serde = createMockSerde();
  });

  afterEach(() => {
    ddbDocMock.reset();
  });

  it('should get checkpoint by checkpoint_id', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-456', 'ns');

    // Mock get checkpoint
    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: checkpointItem,
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
    });

    expect(result).toBeDefined();
    expect(result!.config.configurable?.thread_id).toBe('thread-123');
    expect(result!.config.configurable?.checkpoint_id).toBe('checkpoint-456');
    expect(result!.checkpoint).toBeDefined();
    expect(result!.metadata).toBeDefined();
    expect(result!.pendingWrites).toEqual([]);
  });

  it('should get latest checkpoint without checkpoint_id', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-latest', 'ns');

    // Mock query for latest checkpoint
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [checkpointItem],
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
    });

    expect(result).toBeDefined();
    expect(result!.config.configurable?.checkpoint_id).toBe('checkpoint-latest');
  });

  it('should filter by checkpoint_ns when querying latest', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-1', 'custom-ns');

    // Mock query with namespace filter
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [checkpointItem],
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', undefined, 'custom-ns'),
    });

    expect(result).toBeDefined();
    expect(result!.config.configurable?.checkpoint_ns).toBe('custom-ns');
  });

  it('should return undefined when checkpoint not found', async () => {
    // Mock empty get
    ddbDocMock.onAnyCommand().resolvesOnce({});

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'non-existent', 'ns'),
    });

    expect(result).toBeUndefined();
  });

  it('should return undefined when latest checkpoint not found', async () => {
    // Mock empty query
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [],
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', undefined, 'ns'),
    });

    expect(result).toBeUndefined();
  });

  it('should include pending writes', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-456', 'ns');
    const writes = [
      createMockWriteItem('thread-123', 'checkpoint-456', 'ns', 'task-1', 0),
      createMockWriteItem('thread-123', 'checkpoint-456', 'ns', 'task-1', 1),
    ];

    // Mock get checkpoint
    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: checkpointItem,
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: writes,
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
    });

    expect(result).toBeDefined();
    expect(result!.pendingWrites).toHaveLength(2);
    expect(result!.pendingWrites![0][0]).toBe('task-1'); // task_id
    expect(result!.pendingWrites![0][1]).toBe('test-channel'); // channel
  });

  it('should include parent config when parent_checkpoint_id exists', async () => {
    const checkpointItem = {
      ...createMockCheckpointItem('thread-123', 'checkpoint-456', 'ns'),
      parent_checkpoint_id: 'checkpoint-parent',
    };

    // Mock get checkpoint
    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: checkpointItem,
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
    });

    expect(result).toBeDefined();
    expect(result!.parentConfig).toBeDefined();
    expect(result!.parentConfig?.configurable?.checkpoint_id).toBe('checkpoint-parent');
    expect(result!.parentConfig?.configurable?.thread_id).toBe('thread-123');
  });

  it('should not include parent config when parent_checkpoint_id is undefined', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-456', 'ns');

    // Mock get checkpoint
    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: checkpointItem,
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
    });

    expect(result).toBeDefined();
    expect(result!.parentConfig).toBeUndefined();
  });

  it('should use ConsistentRead for query', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-1', '');

    // Mock query
    ddbDocMock.onAnyCommand().resolvesOnce({
      Items: [checkpointItem],
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', undefined, ''),
    });

    const calls = ddbDocMock.calls();
    expect(calls.length).toBeGreaterThan(0);
  });

  it('should deserialize checkpoint and metadata', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-456', 'ns');

    // Mock get checkpoint
    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: checkpointItem,
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
    });

    expect(serde.loadsTyped).toHaveBeenCalledWith('json', expect.any(Uint8Array));
    expect(result!.checkpoint).toBeDefined();
    expect(result!.metadata).toBeDefined();
  });

  it('should handle empty checkpoint_ns', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-456', '');

    // Mock get checkpoint
    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: checkpointItem,
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', ''),
    });

    expect(result).toBeDefined();
    expect(result!.config.configurable?.checkpoint_ns).toBe('');
  });

  it('should throw error for invalid thread_id', async () => {
    await expect(
      getTupleAction({
        client,
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        serde,
        config: { configurable: { thread_id: '' } },
      }),
    ).rejects.toThrow('thread_id cannot be empty');
  });

  it('should handle DynamoDB errors with retry', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-456', 'ns');

    // First attempt fails, second succeeds
    ddbDocMock.onAnyCommand().rejectsOnce({ name: 'ThrottlingException' });
    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: checkpointItem,
    });

    // Mock query writes
    ddbDocMock.onAnyCommand().resolves({
      Items: [],
    });

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
    });

    expect(result).toBeDefined();
  });

  it('should handle writes query with no Items field', async () => {
    const checkpointItem = createMockCheckpointItem('thread-123', 'checkpoint-456', 'ns');

    // First call: GetCommand for checkpoint
    ddbDocMock.onAnyCommand().resolvesOnce({
      Item: checkpointItem,
    });

    // Second call: QueryCommand for writes - return response without Items field
    ddbDocMock.onAnyCommand().resolves({});

    const result = await getTupleAction({
      client,
      checkpointsTableName: 'checkpoints',
      writesTableName: 'writes',
      serde,
      config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
    });

    expect(result).toBeDefined();
    expect(result?.pendingWrites).toEqual([]);
  });
});
