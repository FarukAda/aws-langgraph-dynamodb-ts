/**
 * Strict DynamoDBDocument mock. REJECTS (throws -> fails the test) on any
 * command that was not explicitly stubbed for that test (REQ-5/AC-2).
 *
 * Wraps aws-sdk-client-mock's mockClient(DynamoDBDocumentClient). Every test
 * must explicitly stub the commands it expects; any other command resolves to
 * a rejected promise carrying STRICT_REJECT_SENTINEL so the failure is loud and
 * traceable.
 */
import {
  BatchGetCommand,
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactGetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient, type AwsClientStub } from 'aws-sdk-client-mock';

import { expectNoUnexpectedCommands } from '../helpers/strict-ddb-assertions';

export const STRICT_REJECT_SENTINEL = 'STRICT_DDB_MOCK_UNEXPECTED_COMMAND';

export interface StrictDdbMock {
  /** The underlying aws-sdk-client-mock stub. */
  mock: AwsClientStub<DynamoDBDocumentClient>;
  /** Reset the stub and re-install the catch-all rejecting handler. */
  reset: () => void;
}

/**
 * The library calls DynamoDB through the `DynamoDBDocument` convenience methods
 * (`client.get`, `client.update`, `client.query`, …) rather than `.send`. The
 * aws-sdk-client-mock stub only instruments `.send`, so we graft the convenience
 * methods on as thin shims that build the matching command and route it through
 * the instrumented `send`. That keeps `commandCalls(GetCommand)` / `.input`
 * assertions working while letting tests pass the stub directly as the client.
 */
const CONVENIENCE_COMMANDS = {
  get: GetCommand,
  put: PutCommand,
  update: UpdateCommand,
  delete: DeleteCommand,
  query: QueryCommand,
  scan: ScanCommand,
  batchWrite: BatchWriteCommand,
  batchGet: BatchGetCommand,
  transactWrite: TransactWriteCommand,
  transactGet: TransactGetCommand,
} as const;

function graftConvenienceMethods(mock: AwsClientStub<DynamoDBDocumentClient>): void {
  const target = mock as unknown as Record<string, unknown>;
  for (const [method, CommandClass] of Object.entries(CONVENIENCE_COMMANDS)) {
    target[method] = (input: object) =>
      (mock as unknown as { send: (c: unknown) => Promise<unknown> }).send(
        new (CommandClass as new (i: object) => unknown)(input ?? {}),
      );
  }
}

/**
 * Create a strict DynamoDBDocumentClient mock. The catch-all `.rejects(...)`
 * ensures any command a test forgot to stub fails loudly rather than resolving
 * to undefined (which silently passes loose suites today).
 */
export function createStrictDdbMock(): StrictDdbMock {
  const mock = mockClient(DynamoDBDocumentClient);

  const install = (): void => {
    mock.reset();
    // Catch-all: any un-stubbed command rejects. Per-test `.on(Command)` stubs
    // registered AFTER this take precedence for matched commands.
    mock
      .onAnyCommand()
      .rejects(
        new Error(
          `${STRICT_REJECT_SENTINEL}: a DynamoDB command was sent that the test did not stub`,
        ),
      );
    // `mock.reset()` rebuilds the stub internals, so re-graft after every reset.
    graftConvenienceMethods(mock);
  };

  install();

  return {
    mock,
    reset: install,
  };
}

export { expectNoUnexpectedCommands };
