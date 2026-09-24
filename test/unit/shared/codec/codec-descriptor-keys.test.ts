import { PayloadLocation, collectS3Keys } from '../../../../src/shared/codec/codec';

const offloaded = (s3Key: string) => ({ location: PayloadLocation.S3, s3Key });
const inline = { location: PayloadLocation.INLINE };

describe('collectS3Keys', () => {
  it('collects the keys of offloaded descriptors and skips inline ones', () => {
    expect(collectS3Keys([offloaded('a'), inline, offloaded('b')])).toEqual(['a', 'b']);
  });

  it('skips an offloaded descriptor carrying no key', () => {
    expect(collectS3Keys([{ location: PayloadLocation.S3 }])).toEqual([]);
  });

  /**
   * Every caller reaches this from a cleanup path, and several of them feed it
   * descriptors read straight off a row. A row this library did not write can
   * hold `null` there, and reading `location` off it used to raise a bare
   * TypeError out of a helper documented to throw nothing at all.
   */
  it('skips an entry a row carries as null or does not carry at all', () => {
    const rowSourced = [null, offloaded('a'), undefined];
    expect(collectS3Keys(rowSourced)).toEqual(['a']);
  });
});
