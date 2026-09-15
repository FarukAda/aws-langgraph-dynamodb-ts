import {
  BACKFILLED_AT,
  decodeScanCursor,
  encodeScanCursor,
  indexTargetOf,
} from '../../../../src/shared/dynamodb/backfill-target';
import { ErrorCode } from '../../../../src/shared/errors/error-code';

describe('indexTargetOf', () => {
  it('indexes a checkpoint META row at the pre-index epoch', () => {
    expect(indexTargetOf({ PK: 'CHKPT#t', SK: 'META##c1', checkpointId: 'c1' })).toEqual({
      tag: 'CHKPT',
      id: 'c1',
      at: BACKFILLED_AT,
    });
  });

  it.each([
    ['a payload row', { PK: 'CHKPT#t', SK: 'PAYLOAD##c1', checkpointId: 'c1' }],
    ['a write row', { PK: 'CHKPT#t', SK: 'WRITE##c1#task#0#ch', checkpointId: 'c1' }],
    ['a META row with no checkpointId', { PK: 'CHKPT#t', SK: 'META##c1' }],
    ['a history message row', { PK: 'HIST#s', SK: 'HISTORY#MSG#01', sessionId: 's' }],
    ['a session row with no sessionId', { PK: 'HIST#s', SK: 'HISTORY#SESSION' }],
    ['a row of no adapter', { PK: 'OTHER#x', SK: 'x' }],
    ['a row whose keys are not strings', { PK: 1, SK: 2 }],
  ])('does not index %s', (_name, row) => {
    expect(indexTargetOf(row)).toBeUndefined();
  });

  it('indexes a store row at its own update time', () => {
    const row = { PK: 'STORE#ns', SK: 'sub#key', updatedAt: '2026-01-02T03:04:05.000Z' };
    expect(indexTargetOf(row)).toEqual({
      tag: 'STORE',
      id: 'sub#key',
      at: '2026-01-02T03:04:05.000Z',
    });
  });

  it('indexes a session row at its own update time', () => {
    const row = {
      PK: 'HIST#s',
      SK: 'HISTORY#SESSION',
      sessionId: 's',
      updatedAt: '2026-01-02T03:04:05.000Z',
    };
    expect(indexTargetOf(row)).toEqual({ tag: 'SESS', id: 's', at: '2026-01-02T03:04:05.000Z' });
  });

  it('falls back to the pre-index epoch for a row carrying no update time', () => {
    expect(indexTargetOf({ PK: 'STORE#ns', SK: 'key' })).toEqual({
      tag: 'STORE',
      id: 'key',
      at: BACKFILLED_AT,
    });
  });
});

describe('scan cursors', () => {
  it('round-trips a scan position', () => {
    const key = { PK: 'CHKPT#t', SK: 'META##c1' };
    expect(decodeScanCursor(encodeScanCursor(key))).toEqual(key);
  });

  it.each([
    ['text that is not valid JSON', Buffer.from('not json', 'utf8').toString('base64url')],
    ['a JSON scalar', Buffer.from('5', 'utf8').toString('base64url')],
    ['a JSON null', Buffer.from('null', 'utf8').toString('base64url')],
    ['an empty string', ''],
  ])('refuses %s', (_name, cursor) => {
    expect(() => decodeScanCursor(cursor)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION, context: { field: 'cursor' } }),
    );
  });
});
