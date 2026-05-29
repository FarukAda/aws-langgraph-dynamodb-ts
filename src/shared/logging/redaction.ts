import type { LogArgument, Logger } from './logger';

/** A value that {@link redactSecrets} can recurse through. */
export type Redactable =
  | string
  | number
  | boolean
  | null
  | undefined
  | Redactable[]
  | { [key: string]: Redactable };

const DEFAULT_SECRET_KEY_PATTERNS: readonly string[] = [
  'accesskey',
  'secretkey',
  'secret',
  'sessiontoken',
  'securitytoken',
  'authorization',
  'password',
  'apikey',
  'bearer',
  'token',
  'privatekey',
];

const REDACTED = '[REDACTED]';

function isSecretKey(key: string, patterns: readonly string[]): boolean {
  const lower = key.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

function isErrorShaped(value: object): boolean {
  return Object.prototype.toString.call(value) === '[object Error]';
}

/**
 * Recursively clone `value`, replacing any value at a secret-looking key with
 * `[REDACTED]`. Cycles become `[Circular]`. Error objects are passed through so
 * stack traces survive. Does not mutate the input.
 */
export function redactSecrets(
  value: Redactable,
  patterns: readonly string[] = DEFAULT_SECRET_KEY_PATTERNS,
): Redactable {
  const seen = new WeakSet<object>();
  const walk = (current: Redactable): Redactable => {
    if (current === null || typeof current !== 'object') return current;
    if (seen.has(current)) return '[Circular]';
    seen.add(current);
    if (Array.isArray(current)) return current.map(walk);
    if (isErrorShaped(current)) return current;
    const out: { [key: string]: Redactable } = {};
    for (const [key, val] of Object.entries(current)) {
      out[key] = isSecretKey(key, patterns) ? REDACTED : walk(val);
    }
    return out;
  };
  return walk(value);
}

/**
 * Wrap a logger so object args are redacted before delegation. The message
 * string is passed through unchanged (never interpolate secrets into it).
 */
export function redactLogger(
  inner: Logger,
  options: { extraKeys?: readonly string[] } = {},
): Logger {
  const patterns = options.extraKeys
    ? [...DEFAULT_SECRET_KEY_PATTERNS, ...options.extraKeys.map((key) => key.toLowerCase())]
    : DEFAULT_SECRET_KEY_PATTERNS;
  const wrap = (args: LogArgument[]): LogArgument[] =>
    args.map((arg) => redactSecrets(arg as Redactable, patterns) as LogArgument);
  return {
    info: (message, ...args) => inner.info(message, ...wrap(args)),
    warn: (message, ...args) => inner.warn(message, ...wrap(args)),
    error: (message, ...args) => inner.error(message, ...wrap(args)),
    debug: (message, ...args) => inner.debug(message, ...wrap(args)),
  };
}
