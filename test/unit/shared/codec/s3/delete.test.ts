import { DeleteObjectsCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';

import { deleteObjects } from '../../../../../src/shared/codec/s3/delete';

const s3Mock = mockClient(S3Client);

afterEach(() => s3Mock.reset());

describe('deleteObjects', () => {
  it('returns an empty array on full success', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({});
    expect(await deleteObjects(new S3Client({ region: 'us-east-1' }), 'b', ['k1', 'k2'])).toEqual(
      [],
    );
  });

  it('returns the keys S3 reported as failed', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({ Errors: [{ Key: 'k2', Code: 'X', Message: 'm' }] });
    expect(await deleteObjects(new S3Client({ region: 'us-east-1' }), 'b', ['k1', 'k2'])).toEqual([
      'k2',
    ]);
  });

  it('ignores reported errors that carry no key', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({ Errors: [{ Code: 'X' }] });
    expect(await deleteObjects(new S3Client({ region: 'us-east-1' }), 'b', ['k1'])).toEqual([]);
  });

  it('is a no-op for an empty key list', async () => {
    expect(await deleteObjects(new S3Client({ region: 'us-east-1' }), 'b', [])).toEqual([]);
    expect(s3Mock.commandCalls(DeleteObjectsCommand)).toHaveLength(0);
  });

  it('chunks more than 1000 keys into multiple requests', async () => {
    s3Mock.on(DeleteObjectsCommand).resolves({});
    const keys = Array.from({ length: 1001 }, (_, i) => `k${i}`);
    await deleteObjects(new S3Client({ region: 'us-east-1' }), 'b', keys);
    const calls = s3Mock.commandCalls(DeleteObjectsCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0].args[0].input.Delete?.Objects).toHaveLength(1000);
    expect(calls[1].args[0].input.Delete?.Objects).toHaveLength(1);
  });
});
