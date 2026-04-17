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

/**
 * Default field names treated as secrets. Case-insensitive substring match — so
 * `AccessKeyId`, `aws_access_key_id`, `X-Amz-Security-Token`, `authorization`
 * all get caught. Extend via {@link redactLogger}'s `extraKeys` option if your
 * workload introduces more sensitive fields (e.g. `api_key`, `bearer`).
 */
const DEFAULT_SECRET_KEY_PATTERNS: readonly string[] = [
  'accesskey',
  'secretkey',
  'secret',
  'sessiontoken',
  'securitytoken',
  'authorization',
  'password',
  'credential',
  'apikey',
  'bearer',
  'token',
  'privatekey',
];

const REDACTED_PLACEHOLDER = '[REDACTED]';

function isSecretKey(key: string, patterns: readonly string[]): boolean {
  const lc = key.toLowerCase();
  return patterns.some((p) => lc.includes(p));
}

/**
 * Recursively clone an object, replacing values at any secret-looking key with
 * `[REDACTED]`. Cycles are broken with a WeakSet. Leaves primitives and non-
 * enumerable values untouched. Does not mutate the input.
 *
 * @param value - Arbitrary value to redact
 * @param patterns - Lower-cased substrings to match against each key
 */
export function redactSecrets(
  value: unknown,
  patterns: readonly string[] = DEFAULT_SECRET_KEY_PATTERNS,
): unknown {
  const seen = new WeakSet<object>();

  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return '[Circular]';
    seen.add(v as object);

    if (Array.isArray(v)) {
      return v.map((el) => walk(el));
    }

    // Preserve Error shapes so stack traces survive redaction.
    // eslint-disable-next-line no-instanceof/no-instanceof
    if (v instanceof Error) {
      return v;
    }

    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = isSecretKey(k, patterns) ? REDACTED_PLACEHOLDER : walk(val);
    }
    return out;
  };

  return walk(value);
}

/**
 * Wrap an existing logger with automatic secret redaction applied to the
 * variadic args (the message string itself is passed through unchanged — don't
 * interpolate secrets into messages). Strings in args are left as-is; only
 * object properties whose keys match a secret pattern are replaced.
 *
 * @example
 * ```ts
 * import { setGlobalLogger, redactLogger, getLogger } from '@farukada/aws-langgraph-dynamodb-ts';
 * setGlobalLogger(redactLogger(getLogger()));
 * ```
 *
 * @param inner - Logger to wrap
 * @param options.extraKeys - Additional lower-cased substrings to treat as secret keys
 */
export function redactLogger(
  inner: Logger,
  options: { extraKeys?: readonly string[] } = {},
): Logger {
  const patterns = options.extraKeys
    ? [...DEFAULT_SECRET_KEY_PATTERNS, ...options.extraKeys.map((k) => k.toLowerCase())]
    : DEFAULT_SECRET_KEY_PATTERNS;
  const wrap = (args: unknown[]): unknown[] => args.map((a) => redactSecrets(a, patterns));
  return {
    info: (msg, ...args) => inner.info(msg, ...wrap(args)),
    warn: (msg, ...args) => inner.warn(msg, ...wrap(args)),
    error: (msg, ...args) => inner.error(msg, ...wrap(args)),
    debug: (msg, ...args) => inner.debug(msg, ...wrap(args)),
  };
}
