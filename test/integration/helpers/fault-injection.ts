import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';

/**
 * A deterministic fault rule. The middleware fails a command when `match` is
 * true, after first letting `skip` matches through, for up to `times`
 * occurrences. `fail` builds the error to throw (e.g. a synthetic
 * TransactionCanceledException or a ValidationException).
 */
export interface FaultRule {
  match: (commandName: string, input: unknown) => boolean;
  fail: () => Error;
  times: number;
  skip?: number;
}

/**
 * Install deterministic fault injection on a base DynamoDB client's middleware
 * stack. Commands flowing through a `DynamoDBDocument` built from this client
 * are intercepted, so adapters that accept an injected `client` can be driven
 * into partial-failure paths against real DynamoDB Local.
 */
export function installFaults(client: DynamoDBClient, rules: FaultRule[]): void {
  client.middlewareStack.add(
    (next, context) => async (args) => {
      const commandName = (context as { commandName?: string }).commandName ?? '';
      const input = (args as { input: unknown }).input;
      const rule = rules.find(
        (candidate) => candidate.times > 0 && candidate.match(commandName, input),
      );
      if (rule) {
        if (rule.skip && rule.skip > 0) {
          rule.skip -= 1;
        } else {
          rule.times -= 1;
          throw rule.fail();
        }
      }
      return next(args);
    },
    { step: 'initialize', name: 'fault-injection', priority: 'high' },
  );
}

/** Build a synthetic AWS error with the given exception `name`. */
export function awsError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

/** Build a synthetic TransactionCanceledException carrying cancellation reasons. */
export function transactionCanceled(reasonCodes: string[]): Error {
  return Object.assign(new Error('Transaction cancelled'), {
    name: 'TransactionCanceledException',
    CancellationReasons: reasonCodes.map((Code) => ({ Code })),
  });
}
