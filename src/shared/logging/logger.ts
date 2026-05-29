/** A value safe to pass as a structured log argument. */
export type LogArgument = string | number | boolean | null | object;

/** Pluggable logging interface — consumers supply their own implementation. */
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

/** Return the injected logger, or {@link SILENT_LOGGER} when none is given. */
export function resolveLogger(logger?: Logger): Logger {
  return logger ?? SILENT_LOGGER;
}
