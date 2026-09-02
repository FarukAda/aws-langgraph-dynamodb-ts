import { offloaderConfigFor } from '../../../../../src/shared/codec/s3/adapter-config';

describe('offloaderConfigFor (CODEC-15)', () => {
  it('inherits the DynamoDB region when the S3 client config names none', () => {
    const config = offloaderConfigFor({ bucketName: 'b' }, 'store', { region: 'eu-central-1' });
    expect(config.clientConfig).toEqual({ region: 'eu-central-1' });
  });

  it('keeps an explicit S3 region and the rest of the S3 client config', () => {
    const config = offloaderConfigFor(
      { bucketName: 'b', clientConfig: { region: 'us-west-2', maxAttempts: 3 } },
      'store',
      { region: 'eu-central-1' },
    );
    expect(config.clientConfig).toEqual({ region: 'us-west-2', maxAttempts: 3 });
  });

  it('adds no client config when neither side names a region', () => {
    expect(offloaderConfigFor({ bucketName: 'b' }, 'store').clientConfig).toBeUndefined();
    expect(offloaderConfigFor({ bucketName: 'b' }, 'store', {}).clientConfig).toBeUndefined();
  });

  it('defaults the key prefix to the adapter-scoped segment and keeps an explicit one', () => {
    expect(offloaderConfigFor({ bucketName: 'b' }, 'checkpointer').keyPrefix).toBe(
      'langgraph-checkpoints/checkpointer/',
    );
    expect(offloaderConfigFor({ bucketName: 'b' }, 'history').keyPrefix).toBe(
      'langgraph-checkpoints/history/',
    );
    expect(offloaderConfigFor({ bucketName: 'b', keyPrefix: 'custom/' }, 'store').keyPrefix).toBe(
      'custom/',
    );
  });
});
