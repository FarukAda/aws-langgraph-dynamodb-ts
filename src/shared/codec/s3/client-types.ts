/**
 * Hides the S3 SDK's own types from this package's declarations.
 *
 * The S3 client, its config and a command are described by the members this
 * package touches, so no shipped declaration imports the optional
 * `@aws-sdk/client-s3` peer and a caller without it installed still compiles
 * (record 1). A real `S3Client` or `S3ClientConfig` satisfies these shapes as
 * it is, so a caller who has the SDK passes its own values unchanged.
 */

/** A region as the SDK accepts it: a string or a provider resolving to one. */
export type S3RegionLike = string | (() => Promise<string>);

/** A value an S3 client option can hold. */
export type S3ClientOption = string | number | boolean | object | null | undefined;

/**
 * The S3 client options this library reads (`region`) or sets (`maxAttempts`),
 * open to every other `S3ClientConfig` key.
 */
export interface S3ClientOptions {
  region?: S3RegionLike;
  maxAttempts?: number;
  [option: string]: S3ClientOption;
}

/**
 * Structural stand-in for `S3ClientConfig`, so the shipped declarations compile
 * without the optional `@aws-sdk/client-s3` peer installed. A literal gets
 * completion for the options the library uses; a typed `S3ClientConfig`
 * variable is accepted as it is.
 */
export type S3ClientConfigLike = S3ClientOptions | object;

/**
 * The options of a config, read through the structural type.
 *
 * Accepts: a config as the caller gave it, or nothing.
 *
 * Returns: the same object seen as {@link S3ClientOptions} so `region` and
 * `maxAttempts` can be read; an absent config reads as empty rather than
 * needing a guard at every call site.
 *
 * Throws: nothing.
 */
export function s3ClientOptions(config: S3ClientConfigLike | undefined): S3ClientOptions {
  return (config ?? {}) as S3ClientOptions;
}

/** What every SDK command object carries: its `input`. */
interface S3CommandLike {
  input: object;
}

/**
 * The S3 client surface this library calls, typed structurally for the same
 * reason. `S3Client` from `@aws-sdk/client-s3` satisfies it.
 */
export interface S3ClientLike {
  send(command: S3CommandLike, options?: object): Promise<object>;
  destroy(): void;
}
