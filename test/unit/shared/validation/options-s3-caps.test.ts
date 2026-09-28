import { assertS3 } from '../../../../src/shared/validation/options';

function refusal(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('assertS3: the download cap against the offload threshold', () => {
  it('refuses an s3.maxDownloadBytes below the default threshold, naming it', () => {
    expect(refusal(() => assertS3({ bucketName: 'b', maxDownloadBytes: 1024 }))).toMatchObject({
      code: 'VALIDATION',
      context: { field: 's3.maxDownloadBytes' },
    });
  });

  it('refuses one below an explicit threshold', () => {
    expect(
      refusal(() => assertS3({ bucketName: 'b', thresholdBytes: 2048, maxDownloadBytes: 2047 })),
    ).toMatchObject({ context: { field: 's3.maxDownloadBytes' } });
  });

  it('accepts a download cap equal to the threshold', () => {
    expect(
      refusal(() => assertS3({ bucketName: 'b', thresholdBytes: 2048, maxDownloadBytes: 2048 })),
    ).toBeUndefined();
  });
});
