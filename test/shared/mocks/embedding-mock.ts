import { BedrockEmbeddings } from '@langchain/aws';

/**
 * Create a mock BedrockEmbeddings instance
 * Returns predictable vector arrays for testing
 */
export function createMockEmbedding(): BedrockEmbeddings {
  return {
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
}

/**
 * Create a mock embedding that returns a specific vector
 */
export function createMockEmbeddingWithVector(vector: number[]): BedrockEmbeddings {
  return {
    embedQuery: jest.fn(async (): Promise<number[]> => vector),
    embedDocuments: jest.fn(async (texts: string[]): Promise<number[][]> => {
      return texts.map(() => vector);
    }),
  } as unknown as BedrockEmbeddings;
}
