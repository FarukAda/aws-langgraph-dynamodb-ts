import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';
import { mockClient } from 'aws-sdk-client-mock';

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
