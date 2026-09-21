/** A value safe to pass as a structured log argument. */
export type LogArgument = string | number | boolean | null | object;

/**
 * Pluggable logging interface — consumers supply their own implementation.
 * `args` are structured fields, at most one plain object per call, so an
 * adapter for a structured logger (pino, winston) can merge them into one
 * record; the message is a fixed string and never carries a value.
 *
 * It is the one piece of foreign code every adapter of this package calls, and
 * it is called almost entirely from `catch` blocks — see
 * `absorbLoggerFailure` for what that costs and where it is paid.
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
 * Run one log call so that a failure of the caller's own logger cannot become
 * the caller's problem.
 *
 * Shared rather than private to the file that first needed it: a `Logger` is
 * an interface a consumer implements, so a log call is foreign code wherever
 * it appears, and a guard each site has to remember is a guard most sites will
 * not have.
 *
 * Swallowed rather than reported onward, because the only channel a report
 * could use is the logger that just broke, and the alternative — writing to
 * the host's console uninvited — is what {@link SILENT_LOGGER} exists to
 * refuse. What the line was going to say is an observation about work that has
 * either succeeded or is already failing for a reason of its own; the error it
 * protects is the one that says what that reason was.
 *
 * Accepts: `emit` — the whole log call as a thunk, so the arguments are built
 * inside the guard too: a formatter that throws while composing the line is
 * the same failure as a transport that throws while writing it.
 *
 * Returns: nothing, and the same nothing whether the line was written or lost.
 *
 * Throws: **nothing**, ever. That is the entire job. The caller's next
 * statement runs, so a path that says what it is about to do and then does it
 * cannot be stopped between the two by the saying.
 */
export function absorbLoggerFailure(emit: () => void): void {
  try {
    emit();
  } catch {
    /** Nowhere left to say it: the reporting channel is the broken part. */
  }
}

/**
 * `inner` with each level wrapped so a throw out of it stops at the log call.
 *
 * A `Logger` is an interface a consumer implements, so every log call this
 * package makes runs foreign code, and almost every one of them is made from
 * inside a `catch`: one that stringifies a circular object, whose transport
 * has closed, or that asserts on a field it did not expect replaces the error
 * the caller actually needs to see with its own. At the retry hook the damage
 * is larger than a swap — `withRetry` calls `onRetry` synchronously and does
 * not catch it, so a logger that throws ends an operation that was still
 * succeeding, after its first transient failure.
 *
 * Wrapped once per adapter, here, rather than remembered at each of the three
 * dozen call sites: a site that forgets is a site whose failure path reports
 * the wrong error, and those sites are exactly the ones a test suite exercises
 * least. `absorbLoggerFailure` stays for the two places that take a
 * `Logger` as an argument and promise, with no precondition on which one,
 * never to throw: `redactLogger`, which a caller may wrap any logger with, and
 * the S3 orphan cleanup.
 */
function containedLogger(inner: Logger): Logger {
  const deliver =
    (level: keyof Logger) =>
    (message: string, ...args: LogArgument[]): void =>
      absorbLoggerFailure(() => inner[level](message, ...args));
  return {
    info: deliver('info'),
    warn: deliver('warn'),
    error: deliver('error'),
    debug: deliver('debug'),
  };
}

/**
 * Resolve an optional logger to a concrete one.
 *
 * Accepts: `logger` — the caller's, or nothing. Its members were validated
 * where the options were.
 *
 * Returns: {@link SILENT_LOGGER} when nothing was given — silent rather than
 * console by default: a library writing to a host's stdout uninvited is a
 * nuisance, and every event it would have written is documented so an operator
 * can opt in. Otherwise a **wrapper** around the caller's logger, not the
 * object itself: the same four levels, delegating each call with its message
 * and arguments unchanged, and absorbing anything the caller's method throws
 * (see `absorbLoggerFailure`). Identity is therefore not preserved, and
 * a caller comparing what it passed in against what an adapter holds would
 * find two different objects; nothing observable about a log line changes.
 *
 * Throws: nothing.
 *
 * Guarantees: every logger this package hands to its own internals has methods
 * that cannot throw, so no `catch` block, and no retry hook, has to treat a log
 * call as a failure path of its own.
 */
export function resolveLogger(logger?: Logger): Logger {
  return logger === undefined ? SILENT_LOGGER : containedLogger(logger);
}
