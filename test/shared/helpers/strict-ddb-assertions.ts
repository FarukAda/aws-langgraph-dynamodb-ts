/**
 * The strict DDB-shape assertion helpers (REQ-6 / REQ-7 / AC-4).
 *
 * Each helper asserts the exact command CLASS *and* the full `.input` object via
 * `.toEqual()`. No partial matching where an exact value is knowable. There is
 * NO snapshot path here (NFR-5/AC-39).
 *
 * These operate on the lib-dynamodb DocumentClient command classes (the mock is
 * a DynamoDBDocumentClient). aws-sdk-client-mock records each command call;
 * `.commandCalls(CommandClass)` returns the matching calls.
 */
import {
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
  type DeleteCommandInput,
  type GetCommandInput,
  type PutCommandInput,
  type QueryCommandInput,
  type TransactWriteCommandInput,
  type UpdateCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { AwsClientStub } from 'aws-sdk-client-mock';

interface ExactOpts {
  /** Which recorded call to assert (default 0 — the first). */
  callIndex?: number;
  /** Expected total number of calls of this command class (default 1). */
  callCount?: number;
}

type AnyStub = AwsClientStub<any>;

function assertExact<I>(
  mock: AnyStub,

  CommandClass: new (input: I) => any,
  expectedInput: I,
  opts?: ExactOpts,
): void {
  const callIndex = opts?.callIndex ?? 0;
  const callCount = opts?.callCount ?? 1;
  const calls = mock.commandCalls(CommandClass);
  expect(calls).toHaveLength(callCount);
  const call = calls[callIndex];
  // Assert the exact command class so a stray command of the wrong type fails.
  expect(call.args[0]).toBeInstanceOf(CommandClass);
  expect(call.args[0].input).toEqual(expectedInput);
}

export function expectExactUpdateCommand(
  mock: AnyStub,
  input: UpdateCommandInput,
  opts?: ExactOpts,
): void {
  assertExact(mock, UpdateCommand, input, opts);
}

export function expectExactQueryCommand(
  mock: AnyStub,
  input: QueryCommandInput,
  opts?: ExactOpts,
): void {
  assertExact(mock, QueryCommand, input, opts);
}

export function expectExactPutCommand(
  mock: AnyStub,
  input: PutCommandInput,
  opts?: ExactOpts,
): void {
  assertExact(mock, PutCommand, input, opts);
}

export function expectExactDeleteCommand(
  mock: AnyStub,
  input: DeleteCommandInput,
  opts?: ExactOpts,
): void {
  assertExact(mock, DeleteCommand, input, opts);
}

export function expectExactGetCommand(
  mock: AnyStub,
  input: GetCommandInput,
  opts?: ExactOpts,
): void {
  assertExact(mock, GetCommand, input, opts);
}

export function expectExactTransactWriteCommand(
  mock: AnyStub,
  input: TransactWriteCommandInput,
  opts?: ExactOpts,
): void {
  assertExact(mock, TransactWriteCommand, input, opts);
}

/**
 * Assert that no command of a type the test did not expect was sent. Pass the
 * set of command classes the test legitimately used; any other recorded call
 * fails. With no args, asserts the mock received zero calls at all.
 */
export function expectNoUnexpectedCommands(
  mock: AnyStub,

  allowed: Array<new (input: any) => any> = [],
): void {
  const total = mock.calls().length;
  const allowedCount = allowed.reduce(
    (sum, CommandClass) => sum + mock.commandCalls(CommandClass).length,
    0,
  );
  expect(total).toBe(allowedCount);
}
