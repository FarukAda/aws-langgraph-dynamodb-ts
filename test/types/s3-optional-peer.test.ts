import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3';
import { expectTypeOf } from 'expect-type';

import type { S3ClientConfigLike, S3ClientLike, S3OffloadConfig } from '../../src/index';

describe('S3 offload types stand on their own (PKG-05)', () => {
  it('accepts every S3ClientConfig shape and an S3Client from the hook', () => {
    const typed: S3ClientConfig = { region: 'eu-west-1' };
    const configs: S3OffloadConfig[] = [
      {
        bucketName: 'b',
        clientConfig: { endpoint: 'http://localhost:9000', forcePathStyle: true },
      },
      { bucketName: 'b', clientConfig: typed },
      { bucketName: 'b', createS3Client: (config) => new S3Client(config) },
    ];
    expect(configs).toHaveLength(3);
    expectTypeOf<S3OffloadConfig['clientConfig']>().toEqualTypeOf<S3ClientConfigLike | undefined>();
    expectTypeOf<S3Client>().toMatchTypeOf<S3ClientLike>();
    expectTypeOf<S3ClientConfig>().toMatchTypeOf<S3ClientConfigLike>();
  });
});
