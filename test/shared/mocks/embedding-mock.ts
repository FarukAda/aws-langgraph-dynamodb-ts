import { BedrockEmbeddings } from '@langchain/aws';

/**
 * Create a mock BedrockEmbeddings instance
 * Returns predictable vector arrays for testing
 */
export function createMockEmbedding(): BedrockEmbeddings {
  const mock = {
    embedQuery: jest.fn(async (text: string): Promise<number[]> => {
      // Return predictable embedding based on text length
      const length = text.length;
      return Array.from({ length: 1536 }, (_, i) => (i + length) / 10000);
    }),
    embedDocuments: jest.fn(async (texts: string[]): Promise<number[][]> => {
      // Return array of embeddings
      return texts.map((text) => {
        const length = text.length;
        return Array.from({ length: 1536 }, (_, i) => (i + length) / 10000);
      });
    }),
  } as unknown as BedrockEmbeddings;

  return mock;
}

/**
 * Create a mock embedding that returns a specific vector
 */
export function createMockEmbeddingWithVector(vector: number[]): BedrockEmbeddings {
  const mock = {
    embedQuery: jest.fn(async (): Promise<number[]> => vector),
    embedDocuments: jest.fn(async (texts: string[]): Promise<number[][]> => {
      return texts.map(() => vector);
    }),
  } as unknown as BedrockEmbeddings;

  return mock;
}

/**
 * Create a mock embedding that throws an error
 */
export function createMockEmbeddingWithError(errorMessage: string): BedrockEmbeddings {
  const mock = {
    embedQuery: jest.fn(async (): Promise<number[]> => {
      throw new Error(errorMessage);
    }),
    embedDocuments: jest.fn(async (): Promise<number[][]> => {
      throw new Error(errorMessage);
    }),
  } as unknown as BedrockEmbeddings;

  return mock;
}

/**
 * Reset all embedding mock calls
 */
export function resetEmbeddingMock(embedding: BedrockEmbeddings) {
  (embedding.embedQuery as jest.Mock).mockClear();
  (embedding.embedDocuments as jest.Mock).mockClear();
}
