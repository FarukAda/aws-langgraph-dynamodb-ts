/**
 * Rejections nobody handled and Node warnings, collected between tests. Node
 * only prints a warning for an unhandled rejection, so without this a suite
 * stays green while the process, in production, would be one rejection away
 * from exiting.
 */
const asyncFailures: string[] = [];

/** Record a rejection no handler claimed. */
export function recordUnhandledRejection(reason: unknown): void {
  const stack = (reason as { stack?: string } | null)?.stack;
  asyncFailures.push(`unhandled rejection: ${stack ?? String(reason)}`);
}

/** Leak and deprecation warnings mean a listener or API is being misused. */
export function recordWarning(warning: Error): void {
  if (warning.name === 'MaxListenersExceededWarning' || warning.name === 'DeprecationWarning') {
    asyncFailures.push(`${warning.name}: ${warning.message}`);
  }
}

/** Throw once for everything recorded since the last drain, then forget it. */
export function drainAsyncFailures(): void {
  if (asyncFailures.length === 0) return;
  const reported = asyncFailures.splice(0).join('\n');
  throw new Error(`Unhandled async failure during this test:\n${reported}`);
}
