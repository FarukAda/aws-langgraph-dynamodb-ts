/**
 * Concurrency harness for the integration race tests (REQ-33 / AC-29).
 *
 * These helpers coordinate multiple REAL clients hitting a real DynamoDB
 * Local instance so two writers genuinely contend on the same optimistic
 * lock. Unlike the unit tier (which fakes timers), races here must run on
 * wall-clock concurrency — the point is to exercise DynamoDB's actual
 * ConditionalCheckFailedException behavior, not a simulated one.
 *
 * `barrier(n)` returns a gate that all `n` racers `await` before issuing
 * their contended write, maximizing the chance both writes land inside the
 * same optimistic-lock window. `raceAll` runs the racers through the barrier
 * and reports, per racer, whether it fulfilled or rejected — so a test can
 * assert "exactly one winner, the loser retried to success" without leaking
 * a rejected promise.
 */

/**
 * A reusable rendezvous gate. The first `count - 1` callers to `wait()` park;
 * the `count`-th caller releases everyone simultaneously. Used so contended
 * writers fire as close together as the event loop allows.
 */
export interface Barrier {
  /** Park until `count` total callers have arrived, then all resolve together. */
  wait(): Promise<void>;
  /** Number of arrivals so far (for assertions / debugging). */
  arrived(): number;
}

export function barrier(count: number): Barrier {
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`barrier(count) requires a positive integer, got ${String(count)}`);
  }
  let arrivedCount = 0;
  const waiters: Array<() => void> = [];
  return {
    async wait(): Promise<void> {
      arrivedCount++;
      if (arrivedCount >= count) {
        // Release everyone parked, then ourselves.
        for (const release of waiters) release();
        waiters.length = 0;
        return;
      }
      await new Promise<void>((resolve) => waiters.push(resolve));
    },
    arrived(): number {
      return arrivedCount;
    },
  };
}

/** Outcome of a single racer: fulfilled with a value, or rejected with an error. */
export type RaceOutcome<T> =
  | { status: 'fulfilled'; value: T }
  | { status: 'rejected'; reason: unknown };

/**
 * Run `racers` concurrently behind a shared barrier so they all release their
 * contended operation at once, then collect each outcome without ever leaving
 * a rejection unhandled. Each racer receives the barrier so it can `await
 * gate.wait()` immediately before its critical section.
 */
export async function raceAll<T>(
  racers: ReadonlyArray<(gate: Barrier) => Promise<T>>,
): Promise<Array<RaceOutcome<T>>> {
  const gate = barrier(racers.length);
  const settled = await Promise.allSettled(racers.map((run) => run(gate)));
  return settled.map((s) =>
    s.status === 'fulfilled'
      ? { status: 'fulfilled', value: s.value }
      : { status: 'rejected', reason: s.reason },
  );
}

/** Count how many outcomes fulfilled. */
export function countFulfilled<T>(outcomes: ReadonlyArray<RaceOutcome<T>>): number {
  return outcomes.filter((o) => o.status === 'fulfilled').length;
}

/** Count how many outcomes rejected. */
export function countRejected<T>(outcomes: ReadonlyArray<RaceOutcome<T>>): number {
  return outcomes.filter((o) => o.status === 'rejected').length;
}
