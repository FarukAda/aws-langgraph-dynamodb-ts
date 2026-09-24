import {
  rejectionProvesForeignRow,
  reportGuardRejection,
} from '../../../../src/checkpointer/internal/pending-writes';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/internal/rows';
import { MAX_LOGGED_VALUE_CHARS, truncateForLog } from '../../../../src/shared/logging/truncate';

describe('rejectionProvesForeignRow', () => {
  const item = { writeGroup: 'G1' } as CheckpointWriteItem;

  it('is true when the rejected row carries a different writeGroup', () => {
    const error = Object.assign(new Error('c'), { Item: { writeGroup: { S: 'OTHER' } } });
    expect(rejectionProvesForeignRow(item, error)).toBe(true);
  });

  it("is false when the rejected row carries this call's own writeGroup", () => {
    const error = Object.assign(new Error('c'), { Item: { writeGroup: { S: 'G1' } } });
    expect(rejectionProvesForeignRow(item, error)).toBe(false);
  });

  it('is false when the rejection carries no attributes', () => {
    expect(rejectionProvesForeignRow(item, new Error('c'))).toBe(false);
  });
});

describe('reportGuardRejection', () => {
  const row = { SK: 'WRITE##c1#task-1#0000000000#ch', channel: 'ch' } as CheckpointWriteItem;
  const logger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() });

  /** The expected outcome of a retry: the row is already this write's. */
  it('reports a same-channel rejection at debug', () => {
    const log = logger();
    const error = Object.assign(new Error('c'), { Item: { channel: { S: 'ch' } } });
    reportGuardRejection({ logger: log } as never, row, error);
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('already committed'), {
      sortKey: row.SK,
      channel: 'ch',
    });
    expect(log.warn).not.toHaveBeenCalled();
  });

  /** Not something this adapter can produce: something else writes this key space. */
  it('warns when the row is held by a different channel', () => {
    const log = logger();
    const error = Object.assign(new Error('c'), { Item: { channel: { S: 'other' } } });
    reportGuardRejection({ logger: log } as never, row, error);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unexpected channel'), {
      sortKey: row.SK,
      expected: 'ch',
      found: 'other',
    });
  });

  /**
   * The channel it reports came off the row that won, so nothing this package
   * validated bounds it. Every other row-sourced string a log line quotes is
   * cut at the same cap.
   */
  it('bounds the channel it read off the winning row', () => {
    const log = logger();
    const found = 'x'.repeat(MAX_LOGGED_VALUE_CHARS * 4);
    const error = Object.assign(new Error('c'), { Item: { channel: { S: found } } });
    reportGuardRejection({ logger: log } as never, row, error);
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('unexpected channel'), {
      sortKey: row.SK,
      expected: 'ch',
      found: truncateForLog(found),
    });
  });

  /** Warning on every unattributed rejection would cry wolf on an ordinary retry. */
  it('treats a rejection carrying no attributes as the ordinary duplicate', () => {
    const log = logger();
    reportGuardRejection({ logger: log } as never, row, new Error('c'));
    expect(log.debug).toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
