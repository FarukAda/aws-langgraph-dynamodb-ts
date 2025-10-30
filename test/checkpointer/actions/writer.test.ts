import { Writer } from '../../../src/checkpointer/actions/writer';

describe('Writer', () => {
  describe('constructor', () => {
    it('should create a valid Writer instance', () => {
      const writer = new Writer({
        thread_id: 'thread-123',
        checkpoint_ns: 'ns',
        checkpoint_id: 'checkpoint-456',
        task_id: 'task-789',
        idx: 0,
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      });

      expect(writer.thread_id).toBe('thread-123');
      expect(writer.checkpoint_ns).toBe('ns');
      expect(writer.checkpoint_id).toBe('checkpoint-456');
      expect(writer.task_id).toBe('task-789');
      expect(writer.idx).toBe(0);
      expect(writer.channel).toBe('messages');
      expect(writer.type).toBe('json');
      expect(writer.value).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('should create Writer with empty checkpoint_ns', () => {
      const writer = new Writer({
        thread_id: 'thread-123',
        checkpoint_ns: '',
        checkpoint_id: 'checkpoint-456',
        task_id: 'task-789',
        idx: 0,
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      });

      expect(writer.checkpoint_ns).toBe('');
    });

    it('should reject invalid thread_id', () => {
      expect(
        () =>
          new Writer({
            thread_id: '',
            checkpoint_ns: 'ns',
            checkpoint_id: 'checkpoint-456',
            task_id: 'task-789',
            idx: 0,
            channel: 'messages',
            type: 'json',
            value: new Uint8Array([1, 2, 3]),
          }),
      ).toThrow('thread_id cannot be empty');
    });

    it('should reject invalid checkpoint_id', () => {
      expect(
        () =>
          new Writer({
            thread_id: 'thread-123',
            checkpoint_ns: 'ns',
            checkpoint_id: '',
            task_id: 'task-789',
            idx: 0,
            channel: 'messages',
            type: 'json',
            value: new Uint8Array([1, 2, 3]),
          }),
      ).toThrow('checkpoint_id cannot be empty');
    });

    it('should reject invalid task_id', () => {
      expect(
        () =>
          new Writer({
            thread_id: 'thread-123',
            checkpoint_ns: 'ns',
            checkpoint_id: 'checkpoint-456',
            task_id: '',
            idx: 0,
            channel: 'messages',
            type: 'json',
            value: new Uint8Array([1, 2, 3]),
          }),
      ).toThrow('task_id cannot be empty');
    });

    it('should reject invalid channel', () => {
      expect(
        () =>
          new Writer({
            thread_id: 'thread-123',
            checkpoint_ns: 'ns',
            checkpoint_id: 'checkpoint-456',
            task_id: 'task-789',
            idx: 0,
            channel: '',
            type: 'json',
            value: new Uint8Array([1, 2, 3]),
          }),
      ).toThrow('channel cannot be empty');
    });

    it('should reject negative idx', () => {
      expect(
        () =>
          new Writer({
            thread_id: 'thread-123',
            checkpoint_ns: 'ns',
            checkpoint_id: 'checkpoint-456',
            task_id: 'task-789',
            idx: -1,
            channel: 'messages',
            type: 'json',
            value: new Uint8Array([1, 2, 3]),
          }),
      ).toThrow('idx must be a non-negative integer');
    });

    it('should reject non-integer idx', () => {
      expect(
        () =>
          new Writer({
            thread_id: 'thread-123',
            checkpoint_ns: 'ns',
            checkpoint_id: 'checkpoint-456',
            task_id: 'task-789',
            idx: 1.5,
            channel: 'messages',
            type: 'json',
            value: new Uint8Array([1, 2, 3]),
          }),
      ).toThrow('idx must be a non-negative integer');
    });
  });

  describe('toDynamoDBItem', () => {
    it('should convert to DynamoDB item format', () => {
      const writer = new Writer({
        thread_id: 'thread-123',
        checkpoint_ns: 'ns',
        checkpoint_id: 'checkpoint-456',
        task_id: 'task-789',
        idx: 5,
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      });

      const item = writer.toDynamoDBItem();

      expect(item.thread_id_checkpoint_id_checkpoint_ns).toBe('thread-123:::checkpoint-456:::ns');
      expect(item.task_id_idx).toBe('task-789:::5');
      expect(item.channel).toBe('messages');
      expect(item.type).toBe('json');
      expect(item.value).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('should handle empty checkpoint_ns', () => {
      const writer = new Writer({
        thread_id: 'thread-123',
        checkpoint_ns: '',
        checkpoint_id: 'checkpoint-456',
        task_id: 'task-789',
        idx: 0,
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      });

      const item = writer.toDynamoDBItem();

      expect(item.thread_id_checkpoint_id_checkpoint_ns).toBe('thread-123:::checkpoint-456:::');
    });
  });

  describe('fromDynamoDBItem', () => {
    it('should parse valid DynamoDB item', () => {
      const item = {
        thread_id_checkpoint_id_checkpoint_ns: 'thread-123:::checkpoint-456:::ns',
        task_id_idx: 'task-789:::5',
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      };

      const writer = Writer.fromDynamoDBItem(item);

      expect(writer.thread_id).toBe('thread-123');
      expect(writer.checkpoint_id).toBe('checkpoint-456');
      expect(writer.checkpoint_ns).toBe('ns');
      expect(writer.task_id).toBe('task-789');
      expect(writer.idx).toBe(5);
      expect(writer.channel).toBe('messages');
      expect(writer.type).toBe('json');
      expect(writer.value).toEqual(new Uint8Array([1, 2, 3]));
    });

    it('should handle empty checkpoint_ns', () => {
      const item = {
        thread_id_checkpoint_id_checkpoint_ns: 'thread-123:::checkpoint-456:::',
        task_id_idx: 'task-789:::0',
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      };

      const writer = Writer.fromDynamoDBItem(item);

      expect(writer.checkpoint_ns).toBe('');
    });

    it('should reject invalid partition key format (too few parts)', () => {
      const item = {
        thread_id_checkpoint_id_checkpoint_ns: 'thread-123:::checkpoint-456',
        task_id_idx: 'task-789:::0',
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      };

      expect(() => Writer.fromDynamoDBItem(item)).toThrow(
        'Invalid partition key format: expected 3 parts, got 2',
      );
    });

    it('should reject invalid partition key format (too many parts)', () => {
      const item = {
        thread_id_checkpoint_id_checkpoint_ns: 'thread-123:::checkpoint-456:::ns:::extra',
        task_id_idx: 'task-789:::0',
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      };

      expect(() => Writer.fromDynamoDBItem(item)).toThrow(
        'Invalid partition key format: expected 3 parts, got 4',
      );
    });

    it('should reject invalid sort key format (too few parts)', () => {
      const item = {
        thread_id_checkpoint_id_checkpoint_ns: 'thread-123:::checkpoint-456:::ns',
        task_id_idx: 'task-789',
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      };

      expect(() => Writer.fromDynamoDBItem(item)).toThrow(
        'Invalid sort key format: expected 2 parts, got 1',
      );
    });

    it('should reject invalid idx value', () => {
      const item = {
        thread_id_checkpoint_id_checkpoint_ns: 'thread-123:::checkpoint-456:::ns',
        task_id_idx: 'task-789:::invalid',
        channel: 'messages',
        type: 'json',
        value: new Uint8Array([1, 2, 3]),
      };

      expect(() => Writer.fromDynamoDBItem(item)).toThrow('Invalid idx value: invalid');
    });
  });

  describe('getPartitionKey', () => {
    it('should generate correct partition key', () => {
      const key = Writer.getPartitionKey({
        thread_id: 'thread-123',
        checkpoint_id: 'checkpoint-456',
        checkpoint_ns: 'ns',
      });

      expect(key).toBe('thread-123:::checkpoint-456:::ns');
    });

    it('should handle empty checkpoint_ns', () => {
      const key = Writer.getPartitionKey({
        thread_id: 'thread-123',
        checkpoint_id: 'checkpoint-456',
        checkpoint_ns: '',
      });

      expect(key).toBe('thread-123:::checkpoint-456:::');
    });
  });

  describe('separator', () => {
    it('should return correct separator', () => {
      expect(Writer.separator()).toBe(':::');
    });
  });
});
