import { PayloadLocation } from '../../../../src/shared/codec/codec';
import { collectS3Keys, releasableS3Keys } from '../../../../src/shared/codec/descriptor-keys';

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

/**
 * A key is the content hash of the payload under its row's path, so a write
 * storing bytes identical to the ones it replaces lands on the *same* key.
 * Releasing "the superseded object" unconditionally would then delete the
 * object the surviving row still points at — a value that reads back as a
 * missing S3 object.
 */
describe('releasableS3Keys', () => {
  it('holds back a key the surviving descriptor still points at', () => {
    expect(releasableS3Keys([offloaded('same')], [offloaded('same')])).toEqual([]);
  });

  it('releases a key nothing surviving points at', () => {
    expect(releasableS3Keys([offloaded('old')], [offloaded('new')])).toEqual(['old']);
  });

  it('releases every key when the surviving payload is inline', () => {
    expect(releasableS3Keys([offloaded('old')], [inline])).toEqual(['old']);
  });

  it('releases every key when nothing survives', () => {
    expect(releasableS3Keys([offloaded('a'), offloaded('b')], [])).toEqual(['a', 'b']);
  });

  it('holds back only the shared keys when several are released at once', () => {
    expect(releasableS3Keys([offloaded('a'), offloaded('b')], [offloaded('b')])).toEqual(['a']);
  });
});
