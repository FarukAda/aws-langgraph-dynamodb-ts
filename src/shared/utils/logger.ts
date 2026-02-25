/**
 * Configurable logger for the library
 *
 * Provides a pluggable logging interface so consumers can integrate
 * with their preferred logging framework (pino, winston, etc.)
 *
 * @example
 * ```TypeScript
 * import { setGlobalLogger } from '@farukada/aws-langgraph-dynamodb-ts';
 *
 * // Use a custom logger
 * setGlobalLogger({
 *   info: (msg, ...args) => myLogger.info(msg, ...args),
 *   warn: (msg, ...args) => myLogger.warn(msg, ...args),
 *   error: (msg, ...args) => myLogger.error(msg, ...args),
 *   debug: (msg, ...args) => myLogger.debug(msg, ...args),
 * });
 *
 * // Disable logging entirely
 * setGlobalLogger({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} });
 * ```
 */

/**
 * Logger interface - consumers can provide their own implementation
 */
export interface Logger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
  debug(message: string, ...args: unknown[]): void;
}

/**
 * Default logger using console
 */
/* eslint-disable no-console -- default logger intentionally uses console; override via setGlobalLogger() */
const defaultLogger: Logger = {
  info: (message: string, ...args: unknown[]) =>
    console.info(`[langgraph-dynamodb] ${message}`, ...args),

  warn: (message: string, ...args: unknown[]) =>
    console.warn(`[langgraph-dynamodb] ${message}`, ...args),

  error: (message: string, ...args: unknown[]) =>
    console.error(`[langgraph-dynamodb] ${message}`, ...args),

  debug: (message: string, ...args: unknown[]) =>
    console.debug(`[langgraph-dynamodb] ${message}`, ...args),
};
/* eslint-enable no-console */

let globalLogger: Logger = defaultLogger;

/**
 * Set a custom global logger for the library
 *
 * @param logger - Custom logger implementation
 */
export function setGlobalLogger(logger: Logger): void {
  globalLogger = logger;
}

/**
 * Get the current global logger
 *
 * @returns The currently configured logger
 */
export function getLogger(): Logger {
  return globalLogger;
}

/**
 * Reset the logger to the default console-based implementation
 */
export function resetLogger(): void {
  globalLogger = defaultLogger;
}
