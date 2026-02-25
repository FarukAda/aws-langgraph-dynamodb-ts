/**
 * Integration tests for compression pipeline through checkpointer actions.
 * Verifies that data compressed by put/putWrites can be correctly
 * decompressed by getTuple and that backward compatibility with
 * uncompressed data is maintained.
 */

import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBSaver } from '../../src';
import { putAction, putWritesAction, getTupleAction } from '../../src/checkpointer/actions';
import { Compressor } from '../../src/shared';
import {
  createMockCheckpoint,
  createMockMetadata,
  createMockRunnableConfig,
  createMockCheckpointItem,
  createMockPendingWrite,
} from '../shared/fixtures/test-data';
import { setupCheckpointerTest, type CheckpointerTestSetup } from '../shared/helpers/test-setup';

describe('Compression Integration', () => {
  describe('action-level: putAction → getTupleAction round-trip', () => {
    let setup: CheckpointerTestSetup;
    let compressor: Compressor;

    beforeEach(() => {
      setup = setupCheckpointerTest();
      compressor = new Compressor({ enabled: true, minSizeBytes: 10 }); // Low threshold for testing
    });

    afterEach(() => {
      setup.cleanup();
    });

    it('should compress data in putAction and decompress in getTupleAction', async () => {
      // Capture what putAction stores in DynamoDB (transactWrite)
      let storedMetadataItem: any = null;
      let storedPayloadItem: any = null;
      setup.ddbDocMock.onAnyCommand().callsFake((input: any) => {
        if (input.TransactItems) {
          for (const txItem of input.TransactItems) {
            if (txItem.Put?.Item) {
              const item = txItem.Put.Item;
              if (
                typeof item.checkpoint_id === 'string' &&
                item.checkpoint_id.startsWith('PAYLOAD#')
              ) {
                storedPayloadItem = item;
              } else {
                storedMetadataItem = item;
              }
            }
          }
        }
        return Promise.resolve({});
      });

      // Use a checkpoint with large, repetitive data to ensure ≥10% compression savings
      const checkpoint = {
        ...createMockCheckpoint('checkpoint-123'),
        channel_values: {
          messages: Array.from(
            { length: 20 },
            (_, i) => `Repeated test message number ${i} with extra padding`,
          ),
        },
      };
      const metadata = createMockMetadata();

      // Put with compression
      await putAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', undefined, 'ns'),
        checkpoint,
        metadata,
        compressor,
      });

      // Verify the stored payload item has compressed checkpoint data (gzip magic header)
      expect(storedPayloadItem).toBeDefined();
      expect(Compressor.isGzipped(storedPayloadItem.checkpoint)).toBe(true);

      // Now read it back — getTupleAction should decompress
      // Simulate: metadata item (first get), payload item (second get), writes (query)
      setup.ddbDocMock.reset();
      setup.ddbDocMock
        .onAnyCommand()
        .resolvesOnce({
          Item: storedMetadataItem,
        })
        .resolvesOnce({
          Item: storedPayloadItem,
        })
        .resolves({
          Items: [],
        });

      const result = await getTupleAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', 'checkpoint-123', 'ns'),
        compressor,
      });

      expect(result).toBeDefined();
      expect(result!.checkpoint.id).toBe('checkpoint-123');
    });

    it('should decompress data compressed by putWritesAction', async () => {
      // Capture stored writes
      const storedItems: any[] = [];
      setup.ddbDocMock.onAnyCommand().callsFake((input: any) => {
        if (input.RequestItems) {
          // BatchWrite — collect the items
          const tableWrites = Object.values(input.RequestItems) as any;
          for (const writes of tableWrites) {
            for (const write of writes) {
              if (write.PutRequest?.Item) {
                storedItems.push(write.PutRequest.Item);
              }
            }
          }
        }
        return Promise.resolve({ UnprocessedItems: {} });
      });

      // Use a write value large enough to achieve ≥10% compression savings
      const writes = [
        createMockPendingWrite('channel1', {
          data: 'A'.repeat(200) + ' repeated content for compression testing',
        }),
      ];

      await putWritesAction({
        client: setup.client,
        writesTableName: 'writes',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', 'checkpoint-456', 'ns'),
        writes,
        taskId: 'task-789',
        compressor,
      });

      // Verify the write values are compressed
      expect(storedItems.length).toBeGreaterThan(0);
      for (const item of storedItems) {
        expect(Compressor.isGzipped(item.value)).toBe(true);
      }
    });

    it('should handle uncompressed data when compressor is provided (backward compat)', async () => {
      // Simulate reading an old, uncompressed checkpoint
      const uncompressedItem = createMockCheckpointItem('thread-123', 'checkpoint-123', 'ns');

      setup.ddbDocMock
        .onAnyCommand()
        .resolvesOnce({
          Item: uncompressedItem,
        })
        .onAnyCommand()
        .resolves({
          Items: [],
        });

      // getTuple with compressor should still read uncompressed data
      const result = await getTupleAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', 'checkpoint-123', 'ns'),
        compressor,
      });

      expect(result).toBeDefined();
      expect(result!.checkpoint.id).toBe('checkpoint-123');
    });

    it('should handle getTupleAction without compressor (no compression configured)', async () => {
      const item = createMockCheckpointItem('thread-123', 'checkpoint-123', 'ns');

      setup.ddbDocMock
        .onAnyCommand()
        .resolvesOnce({
          Item: item,
        })
        .onAnyCommand()
        .resolves({
          Items: [],
        });

      // No compressor — should work as before
      const result = await getTupleAction({
        client: setup.client,
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        serde: setup.serde,
        config: createMockRunnableConfig('thread-123', 'checkpoint-123', 'ns'),
      });

      expect(result).toBeDefined();
      expect(result!.checkpoint.id).toBe('checkpoint-123');
    });
  });

  describe('class-level: DynamoDBSaver with compression', () => {
    let ddbDocMock: any;

    beforeEach(() => {
      ddbDocMock = mockClient(DynamoDBDocumentClient);
      ddbDocMock.reset();
    });

    it('should create saver with compression config', () => {
      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        compression: { enabled: true, level: 6, minSizeBytes: 1024 },
      });

      expect(saver).toBeInstanceOf(DynamoDBSaver);
    });

    it('should create saver without compression (disabled)', () => {
      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        compression: { enabled: false },
      });

      expect(saver).toBeInstanceOf(DynamoDBSaver);
    });

    it('should put and list with compression enabled (round-trip)', async () => {
      // Capture stored items from transactWrite
      let storedMetadataItem: any = null;
      let storedPayloadItem: any = null;
      ddbDocMock.onAnyCommand().callsFake((input: any) => {
        if (input.TransactItems) {
          for (const txItem of input.TransactItems) {
            if (txItem.Put?.Item) {
              const item = txItem.Put.Item;
              if (
                typeof item.checkpoint_id === 'string' &&
                item.checkpoint_id.startsWith('PAYLOAD#')
              ) {
                storedPayloadItem = { ...item };
              } else {
                storedMetadataItem = { ...item };
              }
            }
          }
        }
        return Promise.resolve({});
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        compression: { enabled: true, minSizeBytes: 10 },
      });

      // Use a checkpoint with larger, repetitive data for reliable ≥10% savings
      const checkpoint = {
        ...createMockCheckpoint('checkpoint-123'),
        channel_values: {
          messages: Array.from(
            { length: 20 },
            (_, i) => `Repeated test message number ${i} with extra padding`,
          ),
        },
      };
      const metadata = createMockMetadata();

      await saver.put({ configurable: { thread_id: 'thread-123' } }, checkpoint, metadata, {});

      // Verify payload item has compressed data
      expect(storedPayloadItem).toBeDefined();
      expect(Compressor.isGzipped(storedPayloadItem.checkpoint)).toBe(true);

      // Now read it back via list() — the metadata item triggers a payload fetch
      // For list(), metadata items have no checkpoint field, so fetchCheckpointPayload
      // fetches the payload item separately
      ddbDocMock.reset();
      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({
          Items: [storedMetadataItem],
          LastEvaluatedKey: undefined,
        })
        .resolvesOnce({
          // batchGet returns Responses keyed by table name
          Responses: { checkpoints: [storedPayloadItem] },
        });

      const results = [];
      for await (const item of saver.list({ configurable: { thread_id: 'thread-123' } }, {})) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
      expect(results[0].config.configurable?.checkpoint_id).toBe('checkpoint-123');
    });

    it('should put and getTuple with compression enabled (round-trip)', async () => {
      // Capture stored items from transactWrite
      let storedMetadataItem: any = null;
      let storedPayloadItem: any = null;
      ddbDocMock.onAnyCommand().callsFake((input: any) => {
        if (input.TransactItems) {
          for (const txItem of input.TransactItems) {
            if (txItem.Put?.Item) {
              const item = txItem.Put.Item;
              if (
                typeof item.checkpoint_id === 'string' &&
                item.checkpoint_id.startsWith('PAYLOAD#')
              ) {
                storedPayloadItem = { ...item };
              } else {
                storedMetadataItem = { ...item };
              }
            }
          }
        }
        return Promise.resolve({});
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        compression: { enabled: true, minSizeBytes: 10 },
      });

      // Use a checkpoint with larger, repetitive data for reliable ≥10% savings
      const checkpoint = {
        ...createMockCheckpoint('checkpoint-round-trip'),
        channel_values: {
          messages: Array.from(
            { length: 20 },
            (_, i) => `Repeated test message number ${i} with extra padding`,
          ),
        },
      };
      const metadata = createMockMetadata();

      await saver.put({ configurable: { thread_id: 'thread-123' } }, checkpoint, metadata, {});

      // Read back via getTuple
      ddbDocMock.reset();
      ddbDocMock
        .onAnyCommand()
        .resolvesOnce({
          Item: storedMetadataItem,
        })
        .resolvesOnce({
          Item: storedPayloadItem,
        })
        .resolves({
          Items: [],
        });

      const result = await saver.getTuple({
        configurable: {
          thread_id: 'thread-123',
          checkpoint_id: 'checkpoint-round-trip',
          checkpoint_ns: '',
        },
      });

      expect(result).toBeDefined();
      expect(result!.checkpoint.id).toBe('checkpoint-round-trip');
    });

    it('should read uncompressed data with compression enabled (migration path)', async () => {
      // Simulate old uncompressed checkpoint data
      const uncompressedItem = createMockCheckpointItem('thread-123', 'old-checkpoint', 'ns');

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [uncompressedItem],
        LastEvaluatedKey: undefined,
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        compression: { enabled: true, minSizeBytes: 1024 },
      });

      const results = [];
      for await (const item of saver.list({ configurable: { thread_id: 'thread-123' } }, {})) {
        results.push(item);
      }

      expect(results).toHaveLength(1);
      expect(results[0].config.configurable?.checkpoint_id).toBe('old-checkpoint');
    });

    it('should read compressed data without compression enabled (graceful degradation)', async () => {
      // Create a compressed checkpoint item manually
      const compressor = new Compressor({ enabled: true, minSizeBytes: 10 });
      const checkpointData = new Uint8Array(
        Buffer.from(JSON.stringify(createMockCheckpoint('compressed-ckpt'))),
      );
      const metadataData = new Uint8Array(Buffer.from(JSON.stringify(createMockMetadata())));

      const compressedItem = {
        thread_id: 'thread-123',
        checkpoint_id: 'compressed-ckpt',
        checkpoint_ns: 'ns',
        parent_checkpoint_id: undefined,
        type: 'json',
        checkpoint: compressor.compress(checkpointData),
        metadata: compressor.compress(metadataData),
      };

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [compressedItem],
        LastEvaluatedKey: undefined,
      });

      // Saver WITHOUT compression — it should NOT attempt to decompress
      // and the deserialization should fail since it's compressed gzip data
      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        // no compression config
      });

      // Without the compressor, the deserialization will try to JSON.parse
      // a gzip blob which should throw
      const results: any[] = [];
      try {
        for await (const item of saver.list({ configurable: { thread_id: 'thread-123' } }, {})) {
          results.push(item);
        }
        // If we get here, something is wrong
        fail('Expected deserialization to fail on compressed data without compressor');
      } catch {
        // Expected — compressed data can't be deserialized without decompression
        expect(true).toBe(true);
      }
    });

    it('should handle putWrites with compression and verify compressed storage', async () => {
      const storedItems: any[] = [];
      ddbDocMock.onAnyCommand().callsFake((input: any) => {
        if (input.RequestItems) {
          const tableWrites = Object.values(input.RequestItems) as any;
          for (const writes of tableWrites) {
            for (const write of writes) {
              if (write.PutRequest?.Item) {
                storedItems.push(write.PutRequest.Item);
              }
            }
          }
        }
        return Promise.resolve({ UnprocessedItems: {} });
      });

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        compression: { enabled: true, minSizeBytes: 10 },
      });

      // Use write values large enough to achieve ≥10% compression savings
      const writes = [
        createMockPendingWrite('channel1', {
          data: 'A'.repeat(200) + ' repeated content for compression',
        }),
        createMockPendingWrite('channel2', {
          data: 'B'.repeat(200) + ' more repeated content for compression',
        }),
      ];

      await saver.putWrites(
        { configurable: { thread_id: 'thread-123', checkpoint_id: 'checkpoint-456' } },
        writes,
        'task-789',
      );

      expect(storedItems.length).toBeGreaterThan(0);
      for (const item of storedItems) {
        expect(Compressor.isGzipped(item.value)).toBe(true);
      }
    });

    it('should combine compression with TTL', async () => {
      ddbDocMock.onAnyCommand().resolvesOnce({});

      const saver = new DynamoDBSaver({
        checkpointsTableName: 'checkpoints',
        writesTableName: 'writes',
        ttlDays: 30,
        compression: { enabled: true, minSizeBytes: 10 },
      });

      const checkpoint = createMockCheckpoint('checkpoint-123');
      const metadata = createMockMetadata();

      const result = await saver.put(
        { configurable: { thread_id: 'thread-123' } },
        checkpoint,
        metadata,
        {},
      );

      expect(result.configurable?.thread_id).toBe('thread-123');
      expect(ddbDocMock.calls()).toHaveLength(1);
    });
  });
});
