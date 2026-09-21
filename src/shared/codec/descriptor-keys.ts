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

/**
 * The S3 keys of whichever descriptors are offloaded.
 *
 * Accepts: `descriptors` — any mix of inline and offloaded, including a
 * projection that carries only `location` and `s3Key`, and including none. An
 * offloaded descriptor missing its key is skipped rather than deleted blindly,
 * and so is an entry that is not a descriptor at all: several callers read
 * these straight off a row, and a row this library did not write can hold
 * `null` where the descriptor belongs, or omit the attribute entirely. Widening
 * the parameter rather than making each caller filter is what lets the `Throws`
 * clause below hold for every caller instead of only the careful ones.
 *
 * Returns: the keys, in the order given; an inline payload contributes none,
 * and neither does an absent one.
 *
 * Throws: nothing — this feeds cleanup, which must not fail the operation it
 * follows.
 */
export function collectS3Keys(
  descriptors: readonly (DescriptorRef | null | undefined)[],
): string[] {
  const keys: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor?.location === PayloadLocation.S3 && descriptor.s3Key !== undefined) {
      keys.push(descriptor.s3Key);
    }
  }
  return keys;
}
