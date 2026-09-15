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
 * offloaded descriptor missing its key is skipped rather than deleted blindly.
 *
 * Returns: the keys, in the order given; an inline payload contributes none.
 *
 * Throws: nothing — this feeds cleanup, which must not fail the operation it
 * follows.
 */
export function collectS3Keys(descriptors: readonly DescriptorRef[]): string[] {
  const keys: string[] = [];
  for (const descriptor of descriptors) {
    if (descriptor.location === PayloadLocation.S3 && descriptor.s3Key !== undefined) {
      keys.push(descriptor.s3Key);
    }
  }
  return keys;
}

/**
 * The S3 keys of `release` that `keep` does not also point at.
 *
 * An object's key is the hash of its bytes under its row's path, so a write
 * that stores a value byte-identical to the one it replaces produces the *same*
 * key. Deleting "the superseded object" unconditionally would then delete the
 * object the surviving row still references. Whichever side survives — the new
 * record on a committed write, the previous one on a confirmed non-commit — is
 * passed as `keep`, and its keys are never released.
 *
 * Nothing is lost by holding one back: the surviving row needs those exact
 * bytes, and when it is eventually deleted or overwritten its own cleanup
 * releases them.
 *
 * Accepts: `release` — the descriptors this operation is done with. `keep` —
 * the descriptors of whichever row survives it; empty means nothing survives
 * and everything in `release` may go.
 *
 * Returns: the keys safe to delete.
 *
 * Throws: nothing.
 */
export function releasableS3Keys(
  release: readonly DescriptorRef[],
  keep: readonly DescriptorRef[],
): string[] {
  const live = new Set(collectS3Keys(keep));
  return collectS3Keys(release).filter((key) => !live.has(key));
}
