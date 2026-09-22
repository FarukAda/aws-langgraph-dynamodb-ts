import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';

import {
  getCancellationReasons,
  type RejectionFields,
} from '../../../src/shared/dynamodb/cancellation';

/**
 * Print a measurement the suite deliberately does not assert on.
 *
 * Real AWS varies by day, region and account, so a contention *rate* is an
 * observation rather than a contract: pinning one turns a true measurement into
 * a flaky test. These lines are how a run still reports the number, for
 * whoever is reading it.
 *
 * `process.stdout.write` rather than `console`, which this repository's lint
 * rules ban everywhere.
 */
export function report(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * The error a probe expects, or a failure naming the fact that nothing was
 * thrown. A probe whose whole point is a refusal must never pass by resolving.
 */
export async function rejection(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected this request to be refused, but it resolved');
}

/** How many transaction attempts a contention arm really sent, and how many conflicted. */
export interface AttemptCounter {
  attempts: number;
  conflicts: number;
}

/**
 * Whether a failure is the retryable conflict `TransactWriteItems` raises under
 * contention.
 *
 * It has two shapes and they are not interchangeable: a transaction reports it
 * as a `TransactionCanceledException` carrying a `TransactionConflict`
 * *reason*, while an operation outside a transaction that loses to one reports
 * the bare `TransactionConflictException`. Counting only the bare name would
 * report a contention rate of zero for the very path that produces the
 * conflicts.
 */
function isTransactionConflict(error: Error): boolean {
  if (error.name === 'TransactionConflictException') return true;
  const reasons = getCancellationReasons(error as RejectionFields) ?? [];
  return reasons.some((reason) => reason.Code === 'TransactionConflict');
}

/**
 * Count every `TransactWriteItems` this client sends and every one that came
 * back as a conflict, so a contention arm can report attempts per logical write
 * rather than guess at them.
 *
 * It counts at the `initialize` step, which is inside the SDK's own retry loop,
 * so an attempt the SDK repeated is counted once per wire request rather than
 * once per call — which is the number the measurement is about. Build the
 * client with `maxAttempts: 1` so the SDK's retries cannot silently absorb the
 * failures being counted, exactly as the original live probe did.
 */
export function countTransactAttempts(client: DynamoDBClient): AttemptCounter {
  const counter: AttemptCounter = { attempts: 0, conflicts: 0 };
  client.middlewareStack.add(
    (next, context) => async (args) => {
      if ((context as { commandName?: string }).commandName !== 'TransactWriteItemsCommand') {
        return next(args);
      }
      counter.attempts += 1;
      try {
        return await next(args);
      } catch (error) {
        if (isTransactionConflict(error as Error)) counter.conflicts += 1;
        throw error;
      }
    },
    { step: 'initialize', name: 'countTransactAttempts', priority: 'high' },
  );
  return counter;
}
