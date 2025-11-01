/**
 * Test setup helpers to reduce duplication across test files
 * Provides centralized setup for mocks and common test patterns
 */

import type { AwsStub } from 'aws-sdk-client-mock';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocument,
  DynamoDBDocumentClient,
  type DynamoDBDocumentClientResolvedConfig,
  type ServiceInputTypes,
  type ServiceOutputTypes,
} from '@aws-sdk/lib-dynamodb';

import { createMockSerde } from '../fixtures/test-data';
import { createMockEmbedding } from '../mocks/embedding-mock';

/**
 * Setup result for checkpointer tests
 */
export interface CheckpointerTestSetup {
  ddbDocMock: AwsStub<ServiceInputTypes, ServiceOutputTypes, DynamoDBDocumentClientResolvedConfig>;
  client: DynamoDBDocument;
  serde: any;
  cleanup: () => void;
}

/**
 * Setup result for store tests
 */
export interface StoreTestSetup {
  ddbDocMock: AwsStub<ServiceInputTypes, ServiceOutputTypes, DynamoDBDocumentClientResolvedConfig>;
  client: DynamoDBDocument;
  cleanup: () => void;
}

/**
 * Setup result for store tests with embedding
 */
export interface StoreTestSetupWithEmbedding extends StoreTestSetup {
  embedding: any;
}

/**
 * Setup result for history tests
 */
export interface HistoryTestSetup {
  ddbDocMock: AwsStub<ServiceInputTypes, ServiceOutputTypes, DynamoDBDocumentClientResolvedConfig>;
  client: DynamoDBDocument;
  cleanup: () => void;
}

/**
 * Setup test environment for checkpointer tests
 * Includes DynamoDB mock client and serde mock
 *
 * @returns Test setup with mocks and cleanup function
 */
export function setupCheckpointerTest(): CheckpointerTestSetup {
  const ddbDocMock = mockClient(DynamoDBDocumentClient);
  ddbDocMock.reset();
  const client = DynamoDBDocument.from(new DynamoDBClient({}));
  const serde = createMockSerde();

  return {
    ddbDocMock,
    client,
    serde,
    cleanup: () => {
      ddbDocMock.reset();
    },
  };
}

/**
 * Setup test environment for store tests
 * Includes DynamoDB mock client
 *
 * @returns Test setup with mocks and cleanup function
 */
export function setupStoreTest(): StoreTestSetup {
  const ddbDocMock = mockClient(DynamoDBDocumentClient);
  ddbDocMock.reset();
  const client = DynamoDBDocument.from(new DynamoDBClient({}));

  return {
    ddbDocMock,
    client,
    cleanup: () => {
      ddbDocMock.reset();
    },
  };
}

/**
 * Setup test environment for store tests with embedding support
 * Includes DynamoDB mock client and embedding mock
 *
 * @returns Test setup with mocks and cleanup function
 */
export function setupStoreTestWithEmbedding(): StoreTestSetupWithEmbedding {
  const ddbDocMock = mockClient(DynamoDBDocumentClient);
  ddbDocMock.reset();
  const client = DynamoDBDocument.from(new DynamoDBClient({}));
  const embedding = createMockEmbedding();

  return {
    ddbDocMock,
    client,
    embedding,
    cleanup: () => {
      ddbDocMock.reset();
    },
  };
}

/**
 * Setup test environment for history tests
 * Includes DynamoDB mock client
 *
 * @returns Test setup with mocks and cleanup function
 */
export function setupHistoryTest(): HistoryTestSetup {
  const ddbDocMock = mockClient(DynamoDBDocumentClient);
  ddbDocMock.reset();
  const client = DynamoDBDocument.from(new DynamoDBClient({}));

  return {
    ddbDocMock,
    client,
    cleanup: () => {
      ddbDocMock.reset();
    },
  };
}
