import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  HeadBucketCommand,
  ListObjectVersionsCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { deleteBucketCompletely } from '../../aws/helpers/teardown';

const s3Mock = mockClient(S3Client);

/** What `HeadBucket` answers once the bucket is gone, which is what the waiter waits for. */
const gone = Object.assign(new Error('NotFound'), {
  name: 'NotFound',
  $metadata: { httpStatusCode: 404 },
});

/** The keys one `DeleteObjects` call was asked to remove. */
function deletedOn(call: number): unknown {
  return s3Mock.commandCalls(DeleteObjectsCommand)[call].args[0].input.Delete?.Objects;
}

beforeEach(() => {
  s3Mock.reset();
  s3Mock.on(HeadBucketCommand).rejects(gone);
  s3Mock.on(DeleteObjectsCommand).resolves({});
  s3Mock.on(DeleteBucketCommand).resolves({});
});

/**
 * The real-AWS tier creates a **versioned** bucket for the containment suites,
 * and a versioned bucket cannot be emptied by key. These cases exist because
 * the helper used to list with `ListObjectsV2` and delete by key alone: on a
 * versioned bucket that removes nothing and adds a delete marker, so
 * `DeleteBucket` fails with `BucketNotEmpty` and a failed run leaves a bucket
 * in the account that no later run will ever clean up. This is the one piece of
 * the AWS tier that has to work the first time, which is why it is proven here,
 * against a mocked client, rather than discovered in an `afterAll`.
 */
describe('deleteBucketCompletely on a versioned bucket', () => {
  it('deletes both the noncurrent versions and the delete markers, by version id', async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [
        { Key: 'langgraph-checkpoints/a', VersionId: 'a-v1' },
        { Key: 'langgraph-checkpoints/a', VersionId: 'a-v0' },
      ],
      DeleteMarkers: [{ Key: 'langgraph-checkpoints/a', VersionId: 'a-marker' }],
      IsTruncated: false,
    });

    await deleteBucketCompletely(new S3Client({ region: 'eu-central-1' }), 'b');

    // Every entry carries its own version id. Without them S3 answers the
    // delete by stacking another marker, and the bucket stays non-empty.
    expect(deletedOn(0)).toEqual([
      { Key: 'langgraph-checkpoints/a', VersionId: 'a-v1' },
      { Key: 'langgraph-checkpoints/a', VersionId: 'a-v0' },
      { Key: 'langgraph-checkpoints/a', VersionId: 'a-marker' },
    ]);
    expect(s3Mock.commandCalls(DeleteBucketCommand)).toHaveLength(1);
  });

  it('pages the listing through both continuation markers', async () => {
    s3Mock
      .on(ListObjectVersionsCommand)
      .resolvesOnce({
        Versions: [{ Key: 'a', VersionId: 'a-v1' }],
        IsTruncated: true,
        NextKeyMarker: 'a',
        NextVersionIdMarker: 'a-v1',
      })
      .resolves({ DeleteMarkers: [{ Key: 'b', VersionId: 'b-marker' }], IsTruncated: false });

    await deleteBucketCompletely(new S3Client({ region: 'eu-central-1' }), 'b');

    const listings = s3Mock.commandCalls(ListObjectVersionsCommand);
    expect(listings).toHaveLength(2);
    // A version listing continues on *two* markers, not one: resuming on the
    // key alone would re-read or skip the versions of the key it stopped in.
    expect(listings[1].args[0].input).toMatchObject({ KeyMarker: 'a', VersionIdMarker: 'a-v1' });
    expect(deletedOn(1)).toEqual([{ Key: 'b', VersionId: 'b-marker' }]);
  });

  it('still empties an unversioned bucket, whose versions carry the literal id "null"', async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ Key: 'plain', VersionId: 'null' }],
      IsTruncated: false,
    });

    await deleteBucketCompletely(new S3Client({ region: 'eu-central-1' }), 'b');

    // The tier's other suites run against unversioned buckets and must keep
    // tearing down; `null` is the id S3 gives an object written without
    // versioning, and deleting by it removes the object outright.
    expect(deletedOn(0)).toEqual([{ Key: 'plain', VersionId: 'null' }]);
  });

  it('issues no delete request for an empty bucket, and still removes the bucket', async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({ IsTruncated: false });

    await deleteBucketCompletely(new S3Client({ region: 'eu-central-1' }), 'b');

    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
    expect(s3Mock.commandCalls(DeleteBucketCommand)).toHaveLength(1);
  });

  it('skips an entry S3 reported without a key rather than sending an unusable delete', async () => {
    s3Mock.on(ListObjectVersionsCommand).resolves({
      Versions: [{ VersionId: 'orphan-v1' }, { Key: 'k', VersionId: 'k-v1' }],
      IsTruncated: false,
    });

    await deleteBucketCompletely(new S3Client({ region: 'eu-central-1' }), 'b');

    expect(deletedOn(0)).toEqual([{ Key: 'k', VersionId: 'k-v1' }]);
  });

  it('treats a bucket that was never created as already gone', async () => {
    s3Mock
      .on(ListObjectVersionsCommand)
      .rejects(Object.assign(new Error('NoSuchBucket'), { name: 'NoSuchBucket' }));

    // A `beforeAll` that threw before `CreateBucket` must not make its own
    // `afterAll` fail and hide the real failure.
    await expect(
      deleteBucketCompletely(new S3Client({ region: 'eu-central-1' }), 'b'),
    ).resolves.toBeUndefined();
    expect(s3Mock.commandCalls(DeleteBucketCommand)).toHaveLength(0);
  });

  it('propagates a listing failure that is not a missing bucket', async () => {
    s3Mock
      .on(ListObjectVersionsCommand)
      .rejects(Object.assign(new Error('denied'), { name: 'AccessDenied' }));

    await expect(
      deleteBucketCompletely(new S3Client({ region: 'eu-central-1' }), 'b'),
    ).rejects.toThrow('denied');
  });
});
