/** A value safe to pass as a structured log argument. */
export type LogArgument = string | number | boolean | null | object;

/**
 * Pluggable logging interface — consumers supply their own implementation.
 * `args` are structured fields, at most one plain object per call, so an
 * adapter for a structured logger (pino, winston) can merge them into one
 * record; the message is a fixed string and never carries a value.
 */
export interface Logger {
  info(message: string, ...args: LogArgument[]): void;
  warn(message: string, ...args: LogArgument[]): void;
  error(message: string, ...args: LogArgument[]): void;
  debug(message: string, ...args: LogArgument[]): void;
}

/** Default logger: discards everything. Inject a real logger to enable output. */
export const SILENT_LOGGER: Logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

/**
 * Resolve an optional logger to a concrete one.
 *
 * Accepts: `logger` — the caller's, or nothing.
 *
 * Returns: the caller's logger, or {@link SILENT_LOGGER}. Silent rather than
 * console by default: a library writing to a host's stdout uninvited is a
 * nuisance, and every event it would have written is documented so an operator
 * can opt in.
 *
 * Throws: nothing.
 */
export function resolveLogger(logger?: Logger): Logger {
  return logger ?? SILENT_LOGGER;
}
