import type { S3Client, S3ClientConfig } from '@aws-sdk/client-s3';

let sdkPromise: Promise<typeof import('@aws-sdk/client-s3')> | undefined;

/** Lazily import the optional `@aws-sdk/client-s3` peer, caching the module. */
export async function loadS3Sdk(): Promise<typeof import('@aws-sdk/client-s3')> {
  if (!sdkPromise) {
    sdkPromise = import('@aws-sdk/client-s3');
  }
  return sdkPromise;
}

/** Construct an `S3Client` from `config` using the lazily-loaded SDK. */
export async function createDefaultS3Client(config: S3ClientConfig): Promise<S3Client> {
  const { S3Client: S3ClientCtor } = await loadS3Sdk();
  return new S3ClientCtor(config);
}
