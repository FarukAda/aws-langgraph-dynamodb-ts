import type { S3ClientLike } from '../../../src/index';

/** The parts of the SDK command inputs the fake reads. */
interface CommandInput {
  Key?: string;
  Body?: Uint8Array;
  Delete?: { Objects?: { Key: string }[] };
  LifecycleConfiguration?: { Rules?: object[] };
}

/** What the real SDK command classes expose: a constructor name and an `input`. */
interface SdkCommand {
  constructor: { name: string };
  input: object;
}

/**
 * An in-memory stand-in for S3 that the adapters reach through the
 * `createS3Client` seam. It speaks exactly the commands the offloader sends —
 * PutObject, GetObject, DeleteObjects and the two lifecycle-configuration
 * calls — and keeps every object it holds inspectable, so an integration test
 * can prove that no live object was deleted and count the orphans a race left.
 */
export class MemoryS3 implements S3ClientLike {
  readonly objects = new Map<string, Uint8Array>();
  lifecycle: { Rules?: object[] } | undefined;

  async send(command: SdkCommand): Promise<object> {
    const input = command.input as CommandInput;
    switch (command.constructor.name) {
      case 'PutObjectCommand':
        this.objects.set(input.Key as string, new Uint8Array(input.Body as Uint8Array));
        return {};
      case 'GetObjectCommand': {
        const data = this.objects.get(input.Key as string);
        if (!data) {
          throw Object.assign(new Error('The specified key does not exist.'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        }
        return { ContentLength: data.length, Body: { transformToByteArray: async () => data } };
      }
      case 'DeleteObjectsCommand':
        for (const object of input.Delete?.Objects ?? []) this.objects.delete(object.Key);
        return { Deleted: [] };
      case 'GetBucketLifecycleConfigurationCommand':
        if (!this.lifecycle) {
          throw Object.assign(new Error('no lifecycle'), { name: 'NoSuchLifecycleConfiguration' });
        }
        return this.lifecycle;
      case 'PutBucketLifecycleConfigurationCommand':
        this.lifecycle = { Rules: input.LifecycleConfiguration?.Rules };
        return {};
      default:
        throw new Error(`MemoryS3 does not implement ${command.constructor.name}`);
    }
  }

  destroy(): void {}

  /** Every key currently stored, sorted. */
  keys(): string[] {
    return [...this.objects.keys()].sort();
  }
}
