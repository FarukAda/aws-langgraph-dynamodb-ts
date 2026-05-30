import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { collectS3Keys } from '../../../../src/shared/codec/descriptor-keys';

describe('collectS3Keys', () => {
  it('returns only the keys of S3-located descriptors', () => {
    expect(
      collectS3Keys([
        { location: PayloadLocation.INLINE, serdeType: 'json', bytes: new Uint8Array() },
        { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'k1' },
        { location: PayloadLocation.S3, serdeType: 'json', s3Key: 'k2' },
      ]),
    ).toEqual(['k1', 'k2']);
  });

  it('returns an empty array when nothing was offloaded', () => {
    expect(collectS3Keys([])).toEqual([]);
  });
});
