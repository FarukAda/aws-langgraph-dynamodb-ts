import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocument,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import type { DocItem } from '../../../src/shared/dynamodb/client';

/**
 * Build a `DynamoDBDocument` whose every command rejects unless explicitly
 * stubbed via the returned `mock`. Forces tests to assert the exact command +
 * input rather than letting unexpected calls silently resolve `undefined`.
 */
export function createStrictDocumentMock(): {
  client: DynamoDBDocument;
  mock: ReturnType<typeof mockClient>;
} {
  const client = DynamoDBDocument.from(new DynamoDBClient({ region: 'us-east-1' }));
  const mock = mockClient(client);
  mock.rejects(new Error('unstubbed command'));
  return { client, mock };
}

/**
 * A row write takes one of two shapes and the caller does not choose it: a
 * record whose payload was offloaded commits as a one-item `TransactWriteItems`
 * under a client request token, an inline one as a plain `PutItem`. These three
 * let a test state what should happen to the write without restating that
 * decision.
 *
 * They **give up the shape assertion** in exchange, on purpose: a site using
 * them passes whichever way the write is routed, so it can no longer notice a
 * wrong routing decision. Use them where the subject is what happens *around*
 * the write - the S3 cleanup, the verification read, the returned descriptor -
 * and leave a site whose subject is the shape itself pinned to the one command
 * it expects.
 */
type DocumentMock = ReturnType<typeof mockClient>;

/** Let every row write succeed, whichever shape it takes. */
export function resolveRowWrites(mock: DocumentMock): void {
  mock.on(PutCommand).resolves({});
  mock.on(TransactWriteCommand).resolves({});
}

/** Fail every row write with `error`, whichever shape it takes. */
export function rejectRowWrites(mock: DocumentMock, error: Error): void {
  mock.on(PutCommand).rejects(error);
  mock.on(TransactWriteCommand).rejects(error);
}

/**
 * What either shape carries a row on: the request a plain put sent, or the one
 * its transaction wrapped. Reading the shape rather than the command's class
 * keeps this off `instanceof`, which is forbidden here as it is in the source.
 */
export interface RowPutInput {
  TableName?: string;
  Item?: DocItem;
  ConditionExpression?: string;
  ExpressionAttributeNames?: Record<string, string>;
  ExpressionAttributeValues?: Record<string, string | number | boolean>;
  ReturnValuesOnConditionCheckFailure?: string;
}

/**
 * The put each row write sent, in order, across both shapes — so a test whose
 * subject is the *guard* a write carries can assert it without also deciding
 * which shape the write took.
 */
export function rowWriteInputs(mock: DocumentMock): RowPutInput[] {
  const puts: RowPutInput[] = [];
  for (const call of mock.calls()) {
    const { input } = call.args[0] as {
      input: RowPutInput & { TransactItems?: { Put?: RowPutInput }[] };
    };
    if (input.Item) puts.push(input);
    for (const entry of input.TransactItems ?? []) if (entry.Put) puts.push(entry.Put);
  }
  return puts;
}

/** The rows committed, in the order they were sent, across both shapes. */
export function committedRows(mock: DocumentMock): DocItem[] {
  return rowWriteInputs(mock)
    .map((put) => put.Item)
    .filter((item): item is DocItem => item !== undefined);
}

/**
 * Drive a hand-rolled client double's row write from the one shape its test
 * states the write in.
 *
 * A double that implements only `put` sees nothing at all once the row it
 * writes is offloaded, because that write goes out as a one-item
 * `TransactWriteItems` instead. This unwraps the transaction and hands `write`
 * the `Put` it carries, so a double that counts writes still counts them once
 * and a test that reads `ConditionExpression` off the request still finds it.
 * Like the three above it gives up the shape assertion in exchange.
 */
export function rowWrite(
  write: (input: Record<string, unknown>) => Promise<unknown>,
): (input: { TransactItems: { Put?: Record<string, unknown> }[] }) => Promise<unknown> {
  return async (input) => {
    const put = input.TransactItems[0]?.Put;
    if (put === undefined) {
      /** A readable failure beats a TypeError from the next site that routes a delete here. */
      throw new Error('rowWrite: the transaction carries no Put; this double only answers writes');
    }
    return write(put);
  };
}

/**
 * A row delete takes one of two shapes too, and the caller does not choose it
 * either: a store row is removed inside a one-item `TransactWriteItems` under a
 * request token, while every other delete this package sends is a plain
 * `DeleteItem`. These three let a test state what should happen to a delete
 * without restating that decision, and they give up the shape assertion in
 * exchange, exactly as their write-side counterparts do.
 */
/** Let every row delete succeed, whichever shape it takes. */
export function resolveRowDeletes(mock: DocumentMock): void {
  mock.on(DeleteCommand).resolves({});
  mock.on(TransactWriteCommand).resolves({});
}

/** The keys deleted, in the order they were sent, across both shapes. */
export function deletedKeys(mock: DocumentMock): DocItem[] {
  const keys: DocItem[] = [];
  for (const call of mock.commandCalls(DeleteCommand)) {
    const { Key } = call.args[0].input as { Key?: DocItem };
    if (Key) keys.push(Key);
  }
  for (const call of mock.commandCalls(TransactWriteCommand)) {
    const { TransactItems } = call.args[0].input as {
      TransactItems?: { Delete?: { Key?: DocItem } }[];
    };
    for (const item of TransactItems ?? []) if (item.Delete?.Key) keys.push(item.Delete.Key);
  }
  return keys;
}

/**
 * Answer the two reads a store delete can issue: the pre-read, recognised by
 * the projection it alone asks for, and the confirmation read that resolves an
 * ambiguous spent budget.
 *
 * A delete whose pre-read observes nothing sends no write at all, so a site
 * whose subject is what happens *around* the delete has to seed a row here or
 * it is testing the short-circuit instead.
 */
export function answerDeleteReads(
  mock: DocumentMock,
  observed?: DocItem,
  stillThere?: DocItem,
): void {
  mock
    .on(GetCommand)
    .callsFake((input: { ProjectionExpression?: string }) =>
      String(input.ProjectionExpression).includes('#c') ? { Item: observed } : { Item: stillThere },
    );
}

/** A store row a delete's pre-read can observe, carrying `value` when given one. */
export function observableRow(value?: DocItem): DocItem {
  return { createdAt: 'T0', rev: 'r0', ...(value === undefined ? {} : { value }) };
}

/**
 * The eight `DynamoDBDocument` methods this package calls, all stubbed. An
 * injected `client` double needs every one of them since
 * `assertBaseCollaborators` refuses one missing any — spread this into a
 * lighter double (e.g. `{ send: jest.fn() }`) instead of hand-listing them at
 * each call site.
 */
export function fakeClientMethods(): {
  get: jest.Mock;
  put: jest.Mock;
  delete: jest.Mock;
  update: jest.Mock;
  query: jest.Mock;
  scan: jest.Mock;
  batchWrite: jest.Mock;
  transactWrite: jest.Mock;
} {
  return {
    get: jest.fn(),
    put: jest.fn(),
    delete: jest.fn(),
    update: jest.fn(),
    query: jest.fn(),
    scan: jest.fn(),
    batchWrite: jest.fn(),
    transactWrite: jest.fn(),
  };
}

/** The middleware-stack surface a client double has to present. */
export interface FakeMiddlewareStack {
  add: jest.Mock;
  addRelativeTo: jest.Mock;
  use: jest.Mock;
  identify: () => string[];
  clone: () => FakeMiddlewareStack;
  concat: () => FakeMiddlewareStack;
}

/**
 * A middleware stack that `DynamoDBDocumentClient` accepts from a test double.
 *
 * Its constructor reads `middlewareStack.identify()` and, finding no
 * `serializerMiddleware`, silently swaps in the stack of a throwaway real
 * client and logs `incompatible version of DynamoDBClient` to the console. The
 * swap is harmless — a double never sends — but the warning is not: it names
 * the library in a message about the test's own stub, and one per adapter
 * construction buries the warnings that do mean something. Reporting the name
 * the check looks for keeps the double silent and keeps its stack its own.
 */
export function fakeMiddlewareStack(): FakeMiddlewareStack {
  const stack: FakeMiddlewareStack = {
    add: jest.fn(),
    addRelativeTo: jest.fn(),
    use: jest.fn(),
    identify: () => ['SERIALIZER: serializerMiddleware - serializerMiddleware'],
    clone: () => stack,
    concat: () => stack,
  };
  return stack;
}
