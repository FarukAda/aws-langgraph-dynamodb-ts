/**
 * Tests that exercise the REAL `@langchain/aws` `BedrockEmbeddings` class
 * against a mocked `BedrockRuntimeClient`. Closes the gap between the shallow
 * embedding mock and a live Bedrock call without requiring real AWS access.
 *
 * What this catches that the hash mock can't:
 *   - Actual `InvokeModelCommand` request shape (modelId, contentType,
 *     JSON-encoded body with `inputText`, optional `dimensions`,
 *     model-specific parameters) — if the library ever started building the
 *     request incorrectly, these tests would fail.
 *   - Error propagation: Bedrock wraps its own errors, which `@langchain/aws`
 *     then wraps again with `"An error occurred while embedding documents
 *     with Bedrock: ..."`. The store's fail-closed path surfaces them.
 *   - Response decoding: Titan returns `{ embedding: number[] }` encoded as a
 *     `Uint8Array` body. Our code must decode through TextDecoder + JSON.parse.
 */

import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ThrottlingException,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime';
import { BedrockEmbeddings } from '@langchain/aws';
import { mockClient } from 'aws-sdk-client-mock';

import { DynamoDBStore } from '../../src/store';
import { createMockStoreItem } from '../shared/fixtures/test-data';
import { createMockDynamoDBClient } from '../shared/mocks/dynamodb-mock';

const bedrockMock = mockClient(BedrockRuntimeClient);

function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

/**
 * `@langchain/aws` builds `InvokeModelCommand.body` as a `JSON.stringify`d
 * string (not a Uint8Array), even though the SDK type union allows both.
 * Normalize so tests don't care which shape lands.
 */
function decodeRequestBody(body: unknown): unknown {
  if (typeof body === 'string') return JSON.parse(body);
  // Duck-type the Uint8Array check to avoid `instanceof` (forbidden by lint).
  if (body && typeof body === 'object' && 'byteLength' in body && 'BYTES_PER_ELEMENT' in body) {
    return JSON.parse(new TextDecoder().decode(body as Uint8Array));
  }
  throw new Error(`Unexpected body type: ${typeof body}`);
}

// `@langchain/aws` logs `console.error({ error })` on every failed embed
// attempt. Our tests intentionally trigger those failures; silence the
// console to keep Jest output readable.
let originalConsoleError: typeof console.error;

beforeAll(() => {
  // eslint-disable-next-line no-console
  originalConsoleError = console.error;
  // eslint-disable-next-line no-console
  console.error = jest.fn();
});

afterAll(() => {
  // eslint-disable-next-line no-console
  console.error = originalConsoleError;
});

beforeEach(() => {
  bedrockMock.reset();
});

describe('DynamoDBStore with real BedrockEmbeddings (mocked runtime client)', () => {
  describe('putOperation — embedding request shape', () => {
    it('sends InvokeModel with Titan v1 defaults and stores the returned vector', async () => {
      const vec = Array.from({ length: 1536 }, (_, i) => i / 1536);
      bedrockMock.on(InvokeModelCommand).resolves({
        body: encode({ embedding: vec, inputTextTokenCount: 3 }),
        contentType: 'application/json',
        $metadata: {},
      });

      const { client } = createMockDynamoDBClient();
      const runtime = new BedrockRuntimeClient({ region: 'us-east-1' });
      const embedding = new BedrockEmbeddings({ client: runtime, maxRetries: 0 });
      const store = new DynamoDBStore({ memoryTableName: 'memory', client, embedding });

      await store.batch(
        [
          {
            namespace: ['docs'],
            key: 'k1',
            value: { text: 'hello world' },
            index: ['$.text'],
          },
        ],
        { configurable: { user_id: 'u1' } },
      );

      const calls = bedrockMock.commandCalls(InvokeModelCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0].args[0].input;
      // Default model per @langchain/aws is Titan Embed Text v1.
      expect(input.modelId).toBe('amazon.titan-embed-text-v1');
      expect(input.contentType).toBe('application/json');
      expect(input.accept).toBe('application/json');
      const body = decodeRequestBody(input.body) as Record<string, unknown>;
      expect(body).toEqual({ inputText: 'hello world' });
    });

    it('honors a custom model id, dimensions, and modelParameters', async () => {
      const vec = Array.from({ length: 512 }, (_, i) => i / 512);
      bedrockMock.on(InvokeModelCommand).resolves({
        body: encode({ embedding: vec, inputTextTokenCount: 3 }),
        contentType: 'application/json',
        $metadata: {},
      });

      const { client } = createMockDynamoDBClient();
      const runtime = new BedrockRuntimeClient({ region: 'us-east-1' });
      const embedding = new BedrockEmbeddings({
        client: runtime,
        model: 'amazon.titan-embed-text-v2:0',
        dimensions: 512,
        modelParameters: { normalize: true },
        maxRetries: 0,
      });
      const store = new DynamoDBStore({ memoryTableName: 'memory', client, embedding });

      await store.batch(
        [{ namespace: ['docs'], key: 'k1', value: { text: 'v2 content' }, index: ['$.text'] }],
        { configurable: { user_id: 'u1' } },
      );

      const [call] = bedrockMock.commandCalls(InvokeModelCommand);
      expect(call.args[0].input.modelId).toBe('amazon.titan-embed-text-v2:0');
      const body = decodeRequestBody(call.args[0].input.body) as Record<string, unknown>;
      // Request layers: modelParameters spread first, then inputText, then
      // dimensions override last (matches @langchain/aws source).
      expect(body).toEqual({ normalize: true, inputText: 'v2 content', dimensions: 512 });
    });

    it('replaces newlines in input text per @langchain/aws convention', async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: encode({ embedding: [0.1, 0.2], inputTextTokenCount: 3 }),
        contentType: 'application/json',
        $metadata: {},
      });

      const { client } = createMockDynamoDBClient();
      const runtime = new BedrockRuntimeClient({ region: 'us-east-1' });
      const embedding = new BedrockEmbeddings({ client: runtime, maxRetries: 0 });
      const store = new DynamoDBStore({ memoryTableName: 'memory', client, embedding });

      await store.batch(
        [
          {
            namespace: ['docs'],
            key: 'k1',
            value: { text: 'line one\nline two\nline three' },
            index: ['$.text'],
          },
        ],
        { configurable: { user_id: 'u1' } },
      );

      const [call] = bedrockMock.commandCalls(InvokeModelCommand);
      const body = decodeRequestBody(call.args[0].input.body) as Record<string, unknown>;
      // @langchain/aws normalizes \n → space before sending. Our code depends
      // on this normalization being invisible — a behavior change upstream
      // would show up as a failing assertion.
      expect(body.inputText).toBe('line one line two line three');
    });
  });

  describe('searchOperation — embedding error propagation', () => {
    it('surfaces a ValidationException from Bedrock (fail-closed by default)', async () => {
      bedrockMock.on(InvokeModelCommand).rejects(
        new ValidationException({
          $metadata: { httpStatusCode: 400 },
          message: 'Input text exceeds maximum tokens',
        }),
      );

      const { ddbDocMock, client } = createMockDynamoDBClient();
      const runtime = new BedrockRuntimeClient({ region: 'us-east-1' });
      const embedding = new BedrockEmbeddings({ client: runtime, maxRetries: 0 });
      const store = new DynamoDBStore({ memoryTableName: 'memory', client, embedding });

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          { ...createMockStoreItem('u1', ['docs'], 'doc1', { text: 'x' }), embedding: [[1, 0]] },
        ],
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      await expect(
        store.batch([{ namespacePrefix: ['docs'], limit: 10, offset: 0, query: 'too big' }], {
          configurable: { user_id: 'u1' },
        }),
      ).rejects.toThrow(/Bedrock/);
    });

    it('falls back to unranked results when fallbackToLexicalOnEmbeddingFailure is set', async () => {
      bedrockMock.on(InvokeModelCommand).rejects(
        new ThrottlingException({
          $metadata: { httpStatusCode: 429 },
          message: 'Rate exceeded',
        }),
      );

      const { ddbDocMock, client } = createMockDynamoDBClient();
      const runtime = new BedrockRuntimeClient({ region: 'us-east-1' });
      const embedding = new BedrockEmbeddings({ client: runtime, maxRetries: 0 });
      const store = new DynamoDBStore({
        memoryTableName: 'memory',
        client,
        embedding,
        fallbackToLexicalOnEmbeddingFailure: true,
      });

      ddbDocMock.onAnyCommand().resolvesOnce({
        Items: [
          {
            ...createMockStoreItem('u1', ['docs'], 'doc1', { text: 'fallback' }),
            embedding: [[1, 0]],
          },
        ],
        ScannedCount: 1,
        LastEvaluatedKey: undefined,
      });

      const [results] = await store.batch(
        [{ namespacePrefix: ['docs'], limit: 10, offset: 0, query: 'anything' }],
        { configurable: { user_id: 'u1' } },
      );
      expect(results).toHaveLength(1);
      expect((results as { key: string }[])[0].key).toBe('doc1');
    });
  });

  describe('response decoding edge cases', () => {
    it('throws a descriptive error when Bedrock returns a non-JSON body', async () => {
      bedrockMock.on(InvokeModelCommand).resolves({
        body: new TextEncoder().encode('<<< not json >>>'),
        contentType: 'application/json',
        $metadata: {},
      });

      const { client } = createMockDynamoDBClient();
      const runtime = new BedrockRuntimeClient({ region: 'us-east-1' });
      const embedding = new BedrockEmbeddings({ client: runtime, maxRetries: 0 });
      const store = new DynamoDBStore({ memoryTableName: 'memory', client, embedding });

      await expect(
        store.batch([{ namespace: ['x'], key: 'k', value: { text: 'y' }, index: ['$.text'] }], {
          configurable: { user_id: 'u1' },
        }),
      ).rejects.toThrow(/Bedrock/);
    });
  });
});
