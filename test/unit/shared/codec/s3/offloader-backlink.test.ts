import { buildS3Key } from '../../../../../src/shared/codec/s3/config';
import { backlinkMetadata, metadataBytes } from '../../../../../src/shared/codec/s3/offloader';

const decode = (value: string): string => Buffer.from(value, 'base64url').toString('utf8');

/**
 * S3 user metadata is capped at 2 KB, summed over the UTF-8 bytes of every key
 * and value (S3 User Guide, *Working with object metadata*).
 */
const S3_METADATA_CAP_BYTES = 2048;

describe('backlinkMetadata', () => {
  it('carries the row PK and SK, base64url-encoded and reversible', () => {
    const metadata = backlinkMetadata({ pk: 'CHKPT#t1', sk: 'PAYLOAD##c1' });
    expect(decode(metadata['dynamodb-pk-b64'])).toBe('CHKPT#t1');
    expect(decode(metadata['dynamodb-sk-b64'])).toBe('PAYLOAD##c1');
  });

  /**
   * S3 stores metadata keys lower-cased and asks for US-ASCII values over
   * REST, while a `thread_id` or store key may hold any well-formed UTF-16
   * text. Encoding unconditionally is what keeps every value header-safe.
   */
  it('keeps a non-ASCII identifier header-safe without losing it', () => {
    const metadata = backlinkMetadata({ pk: 'HIST#日本語', sk: 'HISTORY#SESSION' });
    expect(metadata['dynamodb-pk-b64']).toMatch(/^[\w-]+$/);
    expect(decode(metadata['dynamodb-pk-b64'])).toBe('HIST#日本語');
  });

  it('names both fields in lower case, as S3 stores them', () => {
    const names = Object.keys(backlinkMetadata({ pk: 'a', sk: 'b' }));
    expect(names).toEqual(names.map((name) => name.toLowerCase()));
  });
});

/**
 * The cap cannot be reached, and this pins why rather than leaving it as an
 * assumption: the same identifiers are already base64url-encoded into the
 * object key, which `buildS3Key` caps at 1024 bytes, so any row whose key is
 * accepted at all has identifiers far below the metadata budget.
 */
describe('the backlink against S3’s 2 KB metadata cap', () => {
  /** The shortest object id this package draws, a ULID, leaves the most room for identifiers. */
  const OBJECT_ID = '01J9ZQ5X3N8VQ4M6C2T7R0K1HD';

  it('fits for the largest identifiers that still produce a usable object key', () => {
    /** Grown until one byte more would overflow the 1024-byte key cap. */
    let part = 'x';
    for (;;) {
      const next = `${part}x`;
      try {
        buildS3Key('langgraph-checkpoints/', [next], OBJECT_ID);
        part = next;
      } catch {
        break;
      }
    }

    const metadata = backlinkMetadata({ pk: `CHKPT#${part}`, sk: `PAYLOAD##${part}` });
    expect(metadataBytes(metadata)).toBeLessThan(S3_METADATA_CAP_BYTES);
  });

  it('measures the budget the way S3 does, over key and value bytes alike', () => {
    expect(metadataBytes({ ab: 'cde' })).toBe(5);
    expect(metadataBytes({})).toBe(0);
    expect(metadataBytes({ a: 'é' })).toBe(3);
  });
});
