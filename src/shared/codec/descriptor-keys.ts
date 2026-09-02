import { PayloadLocation } from './codec';

/**
 * The part of a descriptor cleanup needs: where the payload lives and, for S3,
 * its key. A full `PayloadDescriptor` satisfies it, and so does the projection
 * a pre-write read returns without the inline bytes.
 */
export interface DescriptorRef {
  location: PayloadLocation;
  s3Key?: string;
}

/** Collect the S3 keys of any offloaded descriptors, for orphan cleanup. */
export function collectS3Keys(descriptors: readonly DescriptorRef[]): string[] {
  const keys: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.location === PayloadLocation.S3 && descriptor.s3Key !== undefined) {
      keys.push(descriptor.s3Key);
    }
  }
  return keys;
}
