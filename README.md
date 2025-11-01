# @farukada/aws-langgraph-dynamodb-ts

[![npm version](https://badge.fury.io/js/@farukada%2Faws-langgraph-dynamodb-ts.svg)](https://badge.fury.io/js/@farukada%2Faws-langgraph-dynamodb-ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5.3-blue)](https://www.typescriptlang.org/)
[![AWS SDK](https://img.shields.io/badge/AWS%20SDK-v3-orange)](https://aws.amazon.com/sdk-for-javascript/)

> ⚠️ **Active Development**: This package is currently in active development. APIs may change between versions.

AWS DynamoDB implementation for LangGraph persistence in TypeScript. Provides checkpoint storage, memory store with semantic search, and chat message history.

## Features

- 🔄 **Checkpoint Saver**: Persistent checkpoint storage for LangGraph state management
- 💾 **Memory Store**: Long-term memory storage with namespace support and optional semantic search
- 💬 **Chat Message History**: Persistent chat message storage with automatic title generation
- ⚡ **Optimized Performance**: Efficient querying with composite keys and batch operations
- 🔒 **Type-Safe**: Full TypeScript support with comprehensive type definitions
- ♻️ **TTL Support**: Automatic data expiration with configurable Time-To-Live
- 🔁 **Retry Logic**: Built-in retry mechanisms for transient DynamoDB errors

## Installation

```bash
npm install @farukada/aws-langgraph-dynamodb-ts
```

### Peer Dependencies

```bash
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @langchain/core @langchain/langgraph @langchain/langgraph-checkpoint

# Optional: For semantic search in Memory Store
npm install @langchain/aws
```

## Infrastructure Setup

Create the required DynamoDB tables using AWS CDK or Terraform:

```typescript
// AWS CDK (TypeScript)
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';

// For DynamoDBSaver - Checkpoints Table
new dynamodb.Table(this, 'Checkpoints', {
  tableName: 'langgraph-checkpoints',
  partitionKey: { name: 'thread_id', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'checkpoint_id', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',
});

// For DynamoDBSaver - Writes Table
new dynamodb.Table(this, 'Writes', {
  tableName: 'langgraph-writes',
  partitionKey: { name: 'thread_id_checkpoint_id_checkpoint_ns', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'task_id_idx', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',
});

// For DynamoDBStore - Memory Table
new dynamodb.Table(this, 'Memory', {
  tableName: 'langgraph-memory',
  partitionKey: { name: 'user_id', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'namespace_key', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',
});

// For DynamoDBChatMessageHistory - Chat History Table
new dynamodb.Table(this, 'ChatHistory', {
  tableName: 'langgraph-chat-history',
  partitionKey: { name: 'userId', type: dynamodb.AttributeType.STRING },
  sortKey: { name: 'sessionId', type: dynamodb.AttributeType.STRING },
  billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
  timeToLiveAttribute: 'ttl',
});
```

```hcl
# Terraform

# For DynamoDBSaver - Checkpoints Table
resource "aws_dynamodb_table" "checkpoints" {
  name         = "langgraph-checkpoints"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "thread_id"
  range_key    = "checkpoint_id"
  
  attribute {
    name = "thread_id"
    type = "S"
  }
  attribute {
    name = "checkpoint_id"
    type = "S"
  }
  
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# For DynamoDBSaver - Writes Table
resource "aws_dynamodb_table" "writes" {
  name         = "langgraph-writes"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "thread_id_checkpoint_id_checkpoint_ns"
  range_key    = "task_id_idx"
  
  attribute {
    name = "thread_id_checkpoint_id_checkpoint_ns"
    type = "S"
  }
  attribute {
    name = "task_id_idx"
    type = "S"
  }
  
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# For DynamoDBStore - Memory Table
resource "aws_dynamodb_table" "memory" {
  name         = "langgraph-memory"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "user_id"
  range_key    = "namespace_key"
  
  attribute {
    name = "user_id"
    type = "S"
  }
  attribute {
    name = "namespace_key"
    type = "S"
  }
  
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}

# For DynamoDBChatMessageHistory - Chat History Table
resource "aws_dynamodb_table" "chat_history" {
  name         = "langgraph-chat-history"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "userId"
  range_key    = "sessionId"
  
  attribute {
    name = "userId"
    type = "S"
  }
  attribute {
    name = "sessionId"
    type = "S"
  }
  
  ttl {
    attribute_name = "ttl"
    enabled        = true
  }
}
```

## Quick Start

### DynamoDBSaver (Checkpoint Storage)

```typescript
import { StateGraph } from '@langchain/langgraph';
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

const checkpointer = new DynamoDBSaver({
  checkpointsTableName: 'langgraph-checkpoints',
  writesTableName: 'langgraph-writes',
  ttlDays: 30, // Optional
  clientConfig: { region: 'us-east-1' }, // Optional
});

// Use with LangGraph
const workflow = new StateGraph({ /* ... */ })
  .addNode('step1', async (state) => { /* ... */ })
  .addEdge('__start__', 'step1');

const app = workflow.compile({ checkpointer });

// State is automatically persisted and can be resumed
await app.invoke(input, {
  configurable: { thread_id: 'conversation-123' }
});
```

### DynamoDBStore (Memory Storage)

```typescript
import { DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';
import { BedrockEmbeddings } from '@langchain/aws';

// Without semantic search
const store = new DynamoDBStore({
  memoryTableName: 'langgraph-memory',
  ttlDays: 90, // Optional
});

// With semantic search
const storeWithEmbeddings = new DynamoDBStore({
  memoryTableName: 'langgraph-memory',
  embedding: new BedrockEmbeddings({
    region: 'us-east-1',
    model: 'amazon.titan-embed-text-v1',
  }),
});

// Store and search memories
await store.batch([
  {
    namespace: ['user', 'preferences'],
    key: 'theme',
    value: { color: 'dark', fontSize: 14 },
  }
], { configurable: { user_id: 'user-123' } });

// Search with filters
const [results] = await store.batch([
  {
    namespacePrefix: ['user'],
    filter: { 'value.color': { $eq: 'dark' } },
    limit: 10,
  }
], { configurable: { user_id: 'user-123' } });

// Use with LangGraph
const app = workflow.compile({ checkpointer, store });
```

### DynamoDBChatMessageHistory (Chat History)

```typescript
import { DynamoDBChatMessageHistory } from '@farukada/aws-langgraph-dynamodb-ts';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

const history = new DynamoDBChatMessageHistory({
  tableName: 'langgraph-chat-history',
  ttlDays: 30, // Optional
  clientConfig: { region: 'us-east-1' }, // Optional
});

// Add message with session title
await history.addMessage('user-123', 'session-456', new HumanMessage('Hello!'), 'Greeting Session');

// Add messages (title auto-generated from first message)
await history.addMessages('user-123', 'session-457', [
  new HumanMessage('Hello!'),
  new AIMessage('Hi there!'),
]);

// Get all messages for a session
const messages = await history.getMessages('user-123', 'session-456');

// List all sessions for a user
const sessions = await history.listSessions('user-123');
// Returns: [{ sessionId, title, createdAt, updatedAt, messageCount }, ...]

// Clear a session
await history.clear('user-123', 'session-456');
```

## API Reference

For detailed API documentation, see the [TypeDoc documentation](./docs/README.md):

- **Classes**: [DynamoDBSaver](./docs/classes/DynamoDBSaver.md), [DynamoDBStore](./docs/classes/DynamoDBStore.md), [DynamoDBChatMessageHistory](./docs/classes/DynamoDBChatMessageHistory.md)
- **Interfaces**: [DynamoDBSaverOptions](./docs/interfaces/DynamoDBSaverOptions.md), [DynamoDBStoreOptions](./docs/interfaces/DynamoDBStoreOptions.md), [DynamoDBChatMessageHistoryOptions](./docs/interfaces/DynamoDBChatMessageHistoryOptions.md), [SessionMetadata](./docs/interfaces/SessionMetadata.md)

## Advanced Features

### Memory Store Filters

```typescript
// JSONPath-based filtering with operators: $eq, $ne, $gt, $gte, $lt, $lte
const [results] = await store.batch([
  {
    namespacePrefix: ['products'],
    filter: {
      'value.price': { $gte: 10, $lte: 100 },
      'value.category': { $eq: 'electronics' },
    },
    limit: 10,
  }
], { configurable: { user_id: 'user-123' } });
```

### Semantic Search

```typescript
// Requires embedding configuration
const [results] = await store.batch([
  {
    namespace: ['documents'],
    key: 'doc1',
    value: { content: 'AI is transforming the world...' },
    index: ['$.content'], // Fields to embed
  }
], config);

// Query semantically
const [semanticResults] = await store.batch([
  {
    namespacePrefix: ['documents'],
    query: 'machine learning basics', // Semantic query
    limit: 5,
  }
], config);
```

### Namespace Organization

```typescript
// Hierarchical organization
['user', userId, 'preferences']
['user', userId, 'conversations', threadId]
['documents', 'category', 'subcategory']
```

## IAM Permissions

Required permissions for your AWS IAM role:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "dynamodb:GetItem",
        "dynamodb:PutItem",
        "dynamodb:UpdateItem",
        "dynamodb:DeleteItem",
        "dynamodb:Query",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:REGION:ACCOUNT:table/langgraph-checkpoints",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/langgraph-writes",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/langgraph-memory",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/langgraph-chat-history"
      ]
    },
    {
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": "arn:aws:bedrock:REGION::foundation-model/amazon.titan-embed-text-v1"
    }
  ]
}
```

## Testing

```bash
# Run tests
npm test

# Run tests with coverage
npm test -- --coverage

# Type checking
npm run typecheck

# Lint
npm run lint
```

## Contributing

Contributions are welcome! Please:

1. Check existing issues or create a new one
2. Fork the repository
3. Create a feature branch
4. Add tests for your changes
5. Submit a pull request

## License

MIT © [FarukAda](https://github.com/farukada)

## Links

- [GitHub Repository](https://github.com/farukada/aws-langgraph-dynamodb-ts)
- [npm Package](https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts)
- [Issue Tracker](https://github.com/farukada/aws-langgraph-dynamodb-ts/issues)
- [LangGraph Documentation](https://langchain-ai.github.io/langgraphjs/)
- [AWS DynamoDB Documentation](https://docs.aws.amazon.com/dynamodb/)

---

Built with [LangGraph](https://github.com/langchain-ai/langgraphjs), [AWS SDK](https://aws.amazon.com/sdk-for-javascript/), and [LangChain](https://github.com/langchain-ai/langchainjs)


