import { type PayloadDescriptor, PayloadLocation } from '../../shared/codec/codec';

/** Collect the S3 keys of any offloaded descriptors, for orphan cleanup. */
export function collectS3Keys(descriptors: readonly PayloadDescriptor[]): string[] {
  const keys: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.location === PayloadLocation.S3) keys.push(descriptor.s3Key);
  }
  return keys;
}
