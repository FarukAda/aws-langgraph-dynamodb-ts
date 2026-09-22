/**
 * The region every live suite runs in. A live run with no region would fall
 * back to whatever the SDK finds, or to a default one suite hard-coded, and
 * report results for a region nobody chose; refusing is the only safe answer.
 */
export function liveRegion(): string {
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region === undefined || region === '') {
    throw new Error(
      'The live-AWS tier needs AWS_REGION (or AWS_DEFAULT_REGION); refusing to guess one.',
    );
  }
  return region;
}
