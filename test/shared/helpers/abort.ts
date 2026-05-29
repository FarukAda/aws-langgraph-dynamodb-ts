/**
 * AbortSignal helpers for cancellation tests (REQ-22 / gap C / AC-18).
 */

/** A signal that is already aborted, optionally with a custom reason. */
export function preAbortedSignal(reason?: unknown): AbortSignal {
  const controller = new AbortController();
  controller.abort(reason);
  return controller.signal;
}

/**
 * Abort a controller after `n` microtask ticks. Deterministic — no wall clock.
 * Returns a promise that resolves once the abort has been scheduled.
 */
export async function abortAfter(
  n: number,
  controller: AbortController,
  reason?: unknown,
): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve();
  }
  controller.abort(reason);
}

/**
 * Assert that `promise` rejects, and that the rejection equals the expected
 * abort reason (the documented contract is `signal.reason ?? new Error('Aborted')`).
 */
export async function expectAbortRejection(
  promise: Promise<unknown>,
  expectedReason: unknown,
): Promise<void> {
  await expect(promise).rejects.toEqual(expectedReason);
}
