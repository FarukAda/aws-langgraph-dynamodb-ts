import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { collectS3Keys } from '../../../../src/shared/codec/descriptor-keys';

const offloaded = (s3Key: string) => ({ location: PayloadLocation.S3, s3Key });
const inline = { location: PayloadLocation.INLINE };

describe('collectS3Keys', () => {
  it('collects the keys of offloaded descriptors and skips inline ones', () => {
    expect(collectS3Keys([offloaded('a'), inline, offloaded('b')])).toEqual(['a', 'b']);
  });

  it('skips an offloaded descriptor carrying no key', () => {
    expect(collectS3Keys([{ location: PayloadLocation.S3 }])).toEqual([]);
  });
});
