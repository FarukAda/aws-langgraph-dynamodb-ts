import { rejectionProvesForeignRow } from '../../../../src/checkpointer/internal/write-guard';
import type { CheckpointWriteItem } from '../../../../src/checkpointer/types';

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
