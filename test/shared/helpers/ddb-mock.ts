import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

import type { DocItem } from '../../../src/shared/dynamodb/types';

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
 * The fields either shape's input carries a row on. Reading the shape rather
 * than the command's class keeps this off `instanceof`, which is forbidden
 * here as it is in the source.
 */
interface RowWriteInput {
  Item?: DocItem;
  TransactItems?: { Put?: { Item?: DocItem } }[];
}

/** The rows committed, in the order they were sent, across both shapes. */
export function committedRows(mock: DocumentMock): DocItem[] {
  const rows: DocItem[] = [];
  for (const call of mock.calls()) {
    const { input } = call.args[0] as { input: RowWriteInput };
    if (input.Item) rows.push(input.Item);
    for (const item of input.TransactItems ?? []) {
      if (item.Put?.Item) rows.push(item.Put.Item);
    }
  }
  return rows;
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
