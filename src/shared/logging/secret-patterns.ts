/** Marker substituted for anything recognised as secret. */
export const REDACTED = '[REDACTED]';

/** Key names (matched case-insensitively as substrings) whose value is a secret. */
export const DEFAULT_SECRET_KEY_PATTERNS: readonly string[] = [
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

/**
 * Secret shapes recognisable in free text, where key-name matching cannot
 * reach: an error's `message`/`stack`, or any other string value. Deliberately
 * high-confidence — each pattern describes a credential *format* rather than a
 * word that merely sounds sensitive — so ordinary operational text survives
 * redaction unchanged.
 */
export const DEFAULT_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /(?:aws_)?(?:secret_access_key|secretaccesskey|password|passwd|api_?key|token)\s*[=:]\s*\S+/gi,
];

/** True when `key` matches any secret-key pattern. */
export function isSecretKey(key: string, patterns: readonly string[]): boolean {
  const lower = key.toLowerCase();
  return patterns.some((pattern) => lower.includes(pattern));
}

/**
 * Replace every recognised secret shape inside `value` with {@link REDACTED},
 * leaving the surrounding text intact so a redacted message stays readable.
 * Each pattern is rebuilt per call so a `g` flag's `lastIndex` never leaks
 * between invocations.
 */
export function redactText(value: string, patterns: readonly RegExp[]): string {
  return patterns.reduce(
    (text, pattern) => text.replace(new RegExp(pattern.source, pattern.flags), REDACTED),
    value,
  );
}

/**
 * A short label for a binary view. Recursing one would explode it into a
 * per-index numeric map, both unreadable and far larger than the value itself.
 */
export function binaryLabel(value: ArrayBufferView): string {
  return `[${value.constructor.name}(${value.byteLength})]`;
}

/** An Error's redacted non-enumerable text, plus whether redaction changed it. */
export interface RedactedErrorText {
  name: string;
  message: string;
  stack: string | undefined;
  changed: boolean;
}

/**
 * Redact an Error's `name`/`message`/`stack`. `changed` reports whether any
 * secret was actually found, which is what decides between passing a bare
 * Error through by reference (preserving its identity and stack trace) and
 * rebuilding it so the secret cannot escape.
 */
export function redactErrorText(error: Error, patterns: readonly RegExp[]): RedactedErrorText {
  const message = redactText(error.message, patterns);
  const stack = error.stack === undefined ? undefined : redactText(error.stack, patterns);
  return {
    name: error.name,
    message,
    stack,
    changed: message !== error.message || stack !== error.stack,
  };
}
