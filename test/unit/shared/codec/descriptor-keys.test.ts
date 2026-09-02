import { type PayloadDescriptor, PayloadLocation } from '../../../../src/shared/codec/codec';
import { collectS3Keys } from '../../../../src/shared/codec/descriptor-keys';

describe('collectS3Keys', () => {
  it('returns only the keys of S3-located descriptors', () => {
    const descriptors: PayloadDescriptor[] = [
      {
        location: PayloadLocation.INLINE,
        serdeType: 'json',
        compressed: false,
        bytes: new Uint8Array(),
      },
      { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key: 'k1' },
      { location: PayloadLocation.S3, serdeType: 'json', compressed: false, s3Key: 'k2' },
    ];
    expect(collectS3Keys(descriptors)).toEqual(['k1', 'k2']);
  });

  it('returns an empty array when nothing was offloaded', () => {
    expect(collectS3Keys([])).toEqual([]);
  });
});
describe('collectS3Keys on bare descriptor refs (STORE-07)', () => {
  it('accepts a projected ref carrying only location and s3Key, and skips an S3 ref without a key', () => {
    expect(collectS3Keys([{ location: PayloadLocation.S3, s3Key: 'k' }])).toEqual(['k']);
    expect(collectS3Keys([{ location: PayloadLocation.S3 }])).toEqual([]);
  });
});
