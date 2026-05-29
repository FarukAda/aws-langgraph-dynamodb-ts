/**
 * Strict unit tests for the Writer class (src/checkpointer/actions/writer.ts).
 *
 * Pure (no DDB): characterizes composite-key construction, the exact
 * toDynamoDBItem() shape, getPartitionKey() formatting, the
 * fromDynamoDBItem() parser (including malformed-key throws), and the
 * constructor validation throws (delegated to the checkpointer validators plus
 * the integer-idx guard).
 */
import { Writer } from '../../../../src/checkpointer/actions/writer';
import type { WriterProps } from '../../../../src/checkpointer/types';
import { THREAD_ID } from '../../../shared/fixtures/test-data';

const CHECKPOINT_ID = 'ckpt-1';
const TASK_ID = 'task-1';
const SEPARATOR = ':::';
const VALUE = new TextEncoder().encode('payload');

function makeProps(overrides: Partial<WriterProps> = {}): WriterProps {
  return {
    thread_id: THREAD_ID,
    checkpoint_ns: '',
    checkpoint_id: CHECKPOINT_ID,
    task_id: TASK_ID,
    idx: 0,
    channel: 'channel-a',
    type: 'json',
    value: VALUE,
    ...overrides,
  };
}

describe('Writer', () => {
  describe('SEPARATOR and getPartitionKey', () => {
    it('exposes the static separator ":::"', () => {
      expect(Writer.SEPARATOR).toBe(SEPARATOR);
    }); // AC-7

    it('joins thread/checkpoint/ns with the separator in getPartitionKey', () => {
      expect(
        Writer.getPartitionKey({
          thread_id: THREAD_ID,
          checkpoint_id: CHECKPOINT_ID,
          checkpoint_ns: 'ns-a',
        }),
      ).toBe([THREAD_ID, CHECKPOINT_ID, 'ns-a'].join(SEPARATOR));
    }); // AC-7
  });

  describe('toDynamoDBItem', () => {
    it('produces the exact DynamoDB write item with composite PK/SK and verbatim payload', () => {
      const item = new Writer(makeProps({ checkpoint_ns: 'ns-a', idx: 3 })).toDynamoDBItem();
      expect(item).toEqual({
        thread_id_checkpoint_id_checkpoint_ns: [THREAD_ID, CHECKPOINT_ID, 'ns-a'].join(SEPARATOR),
        task_id_idx: `${TASK_ID}${SEPARATOR}3`,
        channel: 'channel-a',
        type: 'json',
        value: VALUE,
      });
    }); // AC-7

    it('encodes a negative special-channel idx into the sort key', () => {
      const item = new Writer(makeProps({ idx: -1 })).toDynamoDBItem();
      expect(item.task_id_idx).toBe(`${TASK_ID}${SEPARATOR}-1`);
    }); // AC-7
  });

  describe('fromDynamoDBItem round-trip and parsing', () => {
    it('reconstructs the field values from a well-formed DynamoDB item', () => {
      const original = new Writer(makeProps({ checkpoint_ns: 'ns-a', idx: 5 }));
      const parsed = Writer.fromDynamoDBItem(original.toDynamoDBItem());
      expect({
        thread_id: parsed.thread_id,
        checkpoint_ns: parsed.checkpoint_ns,
        checkpoint_id: parsed.checkpoint_id,
        task_id: parsed.task_id,
        idx: parsed.idx,
        channel: parsed.channel,
        type: parsed.type,
        value: parsed.value,
      }).toEqual({
        thread_id: THREAD_ID,
        checkpoint_ns: 'ns-a',
        checkpoint_id: CHECKPOINT_ID,
        task_id: TASK_ID,
        idx: 5,
        channel: 'channel-a',
        type: 'json',
        value: VALUE,
      });
    }); // AC-7

    it('throws when the partition key does not have exactly 3 parts', () => {
      expect(() =>
        Writer.fromDynamoDBItem({
          thread_id_checkpoint_id_checkpoint_ns: 'only-one-part',
          task_id_idx: `${TASK_ID}${SEPARATOR}0`,
          channel: 'channel-a',
          type: 'json',
          value: VALUE,
        }),
      ).toThrow('Invalid partition key format: expected 3 parts, got 1');
    }); // AC-8

    it('throws when the sort key does not have exactly 2 parts', () => {
      expect(() =>
        Writer.fromDynamoDBItem({
          thread_id_checkpoint_id_checkpoint_ns: [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
          task_id_idx: 'no-separator',
          channel: 'channel-a',
          type: 'json',
          value: VALUE,
        }),
      ).toThrow('Invalid sort key format: expected 2 parts, got 1');
    }); // AC-8

    it('throws when the idx segment is not a number', () => {
      expect(() =>
        Writer.fromDynamoDBItem({
          thread_id_checkpoint_id_checkpoint_ns: [THREAD_ID, CHECKPOINT_ID, ''].join(SEPARATOR),
          task_id_idx: `${TASK_ID}${SEPARATOR}notnum`,
          channel: 'channel-a',
          type: 'json',
          value: VALUE,
        }),
      ).toThrow('Invalid idx value: notnum');
    }); // AC-8
  });

  describe('constructor validation', () => {
    it('throws "idx must be an integer" for a fractional idx', () => {
      expect(() => new Writer(makeProps({ idx: 1.5 }))).toThrow('idx must be an integer');
    }); // AC-8

    it('throws "thread_id cannot be empty" for an empty thread id', () => {
      expect(() => new Writer(makeProps({ thread_id: '' }))).toThrow('thread_id cannot be empty');
    }); // AC-8

    it('throws "task_id cannot be empty" for an empty task id', () => {
      expect(() => new Writer(makeProps({ task_id: '' }))).toThrow('task_id cannot be empty');
    }); // AC-8

    it('throws "channel cannot be empty" for an empty channel', () => {
      expect(() => new Writer(makeProps({ channel: '' }))).toThrow('channel cannot be empty');
    }); // AC-8

    it('throws "checkpoint_id is required" when checkpoint_id is missing (required=true in Writer)', () => {
      expect(
        () => new Writer(makeProps({ checkpoint_id: undefined as unknown as string })),
      ).toThrow('checkpoint_id is required');
    }); // AC-8
  });
});
