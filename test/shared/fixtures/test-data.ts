import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

/**
 * Create a mock checkpoint for testing
 */
export function createMockCheckpoint(id: string): Checkpoint {
  return {
    v: 1,
    id,
    ts: new Date().toISOString(),
    channel_values: {
      messages: ['test message'],
    },
    channel_versions: {
      messages: 1,
    },
    versions_seen: {
      messages: {},
    },
  };
}

/**
 * Create mock checkpoint metadata
 */
export function createMockMetadata(
  source: 'input' | 'update' | 'loop' | 'fork' = 'input',
): CheckpointMetadata<{ writes: any }> {
  return {
    source,
    step: 1,
    writes: null,
    parents: {},
  };
}

/**
 * Create mock serializer protocol
 */
export function createMockSerde() {
  return {
    dumpsTyped: jest.fn(async (value: any): Promise<[string, Uint8Array]> => {
      const serialized = new Uint8Array(Buffer.from(JSON.stringify(value)));
      return ['json', serialized];
    }),
    loadsTyped: jest.fn(async (type: string, value: Uint8Array): Promise<any> => {
      return JSON.parse(Buffer.from(value).toString());
    }),
  };
}

/**
 * Create a mock configurable for RunnableConfig
 */
export function createMockConfigurable(
  threadId: string,
  checkpointId?: string,
  checkpointNs: string = '',
) {
  return {
    thread_id: threadId,
    checkpoint_id: checkpointId,
    checkpoint_ns: checkpointNs,
  };
}

/**
 * Create mock RunnableConfig
 */
export function createMockRunnableConfig(
  threadId: string,
  checkpointId?: string,
  checkpointNs: string = '',
) {
  return {
    configurable: createMockConfigurable(threadId, checkpointId, checkpointNs),
  };
}

/**
 * Create mock pending write
 */
export function createMockPendingWrite(channel: string, value: any): [string, any] {
  return [channel, value];
}

/**
 * Create a mock DynamoDB checkpoint item
 */
export function createMockCheckpointItem(
  threadId: string,
  checkpointId: string,
  checkpointNs: string = '',
) {
  return {
    thread_id: threadId,
    checkpoint_id: checkpointId,
    checkpoint_ns: checkpointNs,
    parent_checkpoint_id: undefined,
    type: 'json',
    checkpoint: new Uint8Array(Buffer.from(JSON.stringify(createMockCheckpoint(checkpointId)))),
    metadata: new Uint8Array(Buffer.from(JSON.stringify(createMockMetadata()))),
  };
}

/**
 * Create a mock DynamoDB write item
 */
export function createMockWriteItem(
  threadId: string,
  checkpointId: string,
  checkpointNs: string,
  taskId: string,
  idx: number,
) {
  return {
    thread_id_checkpoint_id_checkpoint_ns: `${threadId}:::${checkpointId}:::${checkpointNs}`,
    task_id_idx: `${taskId}:::${idx}`,
    channel: 'test-channel',
    type: 'json',
    value: new Uint8Array(Buffer.from(JSON.stringify({ data: 'test' }))),
  };
}

/**
 * Create a mock store item
 */
export function createMockStoreItem(userId: string, namespace: string[], key: string, value: any) {
  const namespacePath = namespace.join('/');
  return {
    user_id: userId,
    namespace_key: `${namespacePath}#${key}`,
    namespace: namespacePath,
    key,
    value,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}
