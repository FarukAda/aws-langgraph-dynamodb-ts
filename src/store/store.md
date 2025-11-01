# DynamoDBStore - Memory Storage

The `DynamoDBStore` provides persistent memory storage for LangGraph applications with support for hierarchical namespaces, filtering, and optional semantic search. It allows agents to store and retrieve contextual information, user preferences, and knowledge across sessions.

## Overview

The store module implements the `BaseStore` interface from `@langchain/langgraph`, storing memory items in a DynamoDB table. Each item is organized by user ID and namespace, with support for complex queries and semantic similarity search.

### Key Features

- 📦 **Hierarchical Namespaces**: Organize memories with multi-level namespaces
- 🔍 **Advanced Filtering**: JSONPath-based filters with comparison operators
- 🧠 **Semantic Search**: Optional vector similarity search via AWS Bedrock embeddings
- 🚀 **Batch Operations**: Execute multiple operations in parallel
- 👤 **User Isolation**: Separate memories by user ID
- ⏱️ **TTL Support**: Automatic memory expiration
- 🔁 **Retry Logic**: Built-in retry for transient DynamoDB errors
- 🎯 **Type Safe**: Full TypeScript support with strict types

## Installation

```bash
npm install @farukada/aws-langgraph-dynamodb-ts @langchain/langgraph @langchain/aws
```

## Table Schema

### Memory Table

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `user_id` | String | Partition Key | User identifier for data isolation |
| `namespace_key` | String | Sort Key | Composite key: `{namespace}#{key}` |
| `namespace` | String | - | Hierarchical namespace (e.g., "user/preferences") |
| `key` | String | - | Item key within namespace |
| `value` | Map | - | Stored item value (any JSON-serializable data) |
| `embedding` | List\<Number\> | - | Optional vector embedding for semantic search |
| `ttl` | Number | - | Optional expiration timestamp (Unix epoch) |
| `created_at` | String | - | ISO 8601 timestamp |
| `updated_at` | String | - | ISO 8601 timestamp |

### Global Secondary Index (Optional)

For semantic search, you can add a GSI:

| Index Name | Partition Key | Sort Key | Projected Attributes |
|-----------|---------------|----------|---------------------|
| `embedding-index` | `user_id` | - | ALL or specific fields |

## Basic Usage

### Creating a Store

```typescript
import { DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';

// Basic store without semantic search
const store = new DynamoDBStore({
  memoryTableName: 'langgraph-memory',
  ttlDays: 90, // Optional: Auto-delete after 90 days
  clientConfig: {
    region: 'us-east-1',
    // ... other AWS SDK config
  },
});
```

### With Semantic Search

```typescript
import { BedrockEmbeddings } from '@langchain/aws';

const storeWithEmbeddings = new DynamoDBStore({
  memoryTableName: 'langgraph-memory',
  embedding: new BedrockEmbeddings({
    region: 'us-east-1',
    model: 'amazon.titan-embed-text-v1',
  }),
});
```

### Basic Operations

```typescript
const config = { configurable: { user_id: 'user-123' } };

// Put operation - store a memory item
await store.batch([
  {
    namespace: ['user', 'preferences'],
    key: 'theme',
    value: { color: 'dark', fontSize: 14 },
  }
], config);

// Get operation - retrieve a memory item
const [result] = await store.batch([
  {
    namespace: ['user', 'preferences'],
    key: 'theme',
  }
], config);

console.log(result); // { namespace: ['user', 'preferences'], key: 'theme', value: { color: 'dark', fontSize: 14 }, ... }

// Search operation - find items by namespace prefix
const [searchResults] = await store.batch([
  {
    namespacePrefix: ['user'],
    limit: 10,
    offset: 0,
  }
], config);

// List namespaces operation - get all unique namespaces
const [namespaces] = await store.batch([
  {
    limit: 10,
    offset: 0,
  }
], config);

console.log(namespaces); // [['user', 'preferences'], ['user', 'settings'], ...]
```

## Advanced Usage

### Batch Operations

Execute multiple operations in parallel for better performance:

```typescript
const results = await store.batch([
  // Put operations
  {
    namespace: ['user', 'profile'],
    key: 'name',
    value: 'John Doe',
  },
  {
    namespace: ['user', 'profile'],
    key: 'email',
    value: 'john@example.com',
  },
  // Get operation
  {
    namespace: ['user', 'preferences'],
    key: 'theme',
  },
  // Search operation
  {
    namespacePrefix: ['user', 'profile'],
    limit: 5,
  },
], config);

// results[0] = undefined (put returns void)
// results[1] = undefined (put returns void)
// results[2] = Item | null (get result)
// results[3] = SearchItem[] (search results)
```

### Filter Expressions

Use JSONPath-based filters to query stored values:

```typescript
// Filter with comparison operators
const [results] = await store.batch([
  {
    namespacePrefix: ['products'],
    filter: {
      'value.price': { $gte: 10, $lte: 100 },
      'value.category': { $eq: 'electronics' },
      'value.inStock': { $eq: true },
    },
    limit: 10,
  }
], config);
```

#### Supported Operators

| Operator | Description | Example |
|----------|-------------|---------|
| `$eq` | Equal to | `{ 'value.status': { $eq: 'active' } }` |
| `$ne` | Not equal to | `{ 'value.type': { $ne: 'archived' } }` |
| `$gt` | Greater than | `{ 'value.score': { $gt: 50 } }` |
| `$gte` | Greater than or equal | `{ 'value.age': { $gte: 18 } }` |
| `$lt` | Less than | `{ 'value.price': { $lt: 100 } }` |
| `$lte` | Less than or equal | `{ 'value.rating': { $lte: 5 } }` |

#### Complex Filters

```typescript
// Multiple conditions (AND logic)
const [results] = await store.batch([
  {
    namespacePrefix: ['tasks'],
    filter: {
      'value.priority': { $gte: 7 },
      'value.status': { $eq: 'pending' },
      'value.assignee': { $ne: 'unassigned' },
    },
    limit: 20,
  }
], config);

// Nested object filtering
const [userResults] = await store.batch([
  {
    namespacePrefix: ['users'],
    filter: {
      'value.profile.age': { $gte: 21 },
      'value.profile.country': { $eq: 'US' },
    },
  }
], config);
```

### Semantic Search

When embeddings are configured, you can perform semantic similarity search:

```typescript
// Store items with embeddings
await storeWithEmbeddings.batch([
  {
    namespace: ['documents'],
    key: 'doc1',
    value: { content: 'Artificial Intelligence is transforming the world...' },
    index: ['$.content'], // JSONPath to fields for embedding
  },
  {
    namespace: ['documents'],
    key: 'doc2',
    value: { content: 'Machine learning algorithms learn from data...' },
    index: ['$.content'],
  },
], config);

// Query semantically similar items
const [results] = await storeWithEmbeddings.batch([
  {
    namespacePrefix: ['documents'],
    query: 'what is AI and ML?', // Natural language query
    limit: 5,
  }
], config);

// Results are sorted by similarity score
results.forEach(item => {
  console.log(`Score: ${item.score}, Content: ${item.value.content}`);
});
```

#### Combining Semantic Search with Filters

```typescript
// Semantic search with additional filters
const [results] = await storeWithEmbeddings.batch([
  {
    namespacePrefix: ['documents'],
    query: 'machine learning tutorial',
    filter: {
      'value.category': { $eq: 'education' },
      'value.difficulty': { $lte: 3 },
    },
    limit: 10,
  }
], config);
```

### Namespace Organization Strategies

#### By User and Feature

```typescript
// User-specific namespaces
['user', userId, 'preferences']
['user', userId, 'settings', 'notifications']
['user', userId, 'history', 'searches']

// Store user preferences
await store.batch([
  {
    namespace: ['user', 'user-123', 'preferences'],
    key: 'theme',
    value: { mode: 'dark' },
  }
], config);
```

#### By Entity Type

```typescript
// Hierarchical categorization
['products', 'electronics', 'computers']
['products', 'clothing', 'shoes']
['documents', 'legal', 'contracts']

// Store product information
await store.batch([
  {
    namespace: ['products', 'electronics', 'computers'],
    key: 'laptop-001',
    value: { name: 'MacBook Pro', price: 2499 },
  }
], config);
```

#### By Workflow and Session

```typescript
// Workflow-specific memories
['workflow', workflowId, 'context']
['workflow', workflowId, 'intermediate-results']
['agent', agentId, 'session', sessionId, 'state']

// Store workflow context
await store.batch([
  {
    namespace: ['workflow', 'wf-789', 'context'],
    key: 'current-step',
    value: { step: 3, data: {...} },
  }
], config);
```

### Using with LangGraph

```typescript
import { StateGraph } from '@langchain/langgraph';

interface WorkflowState {
  messages: string[];
  userPreferences?: any;
}

const workflow = new StateGraph<WorkflowState>({
  channels: {
    messages: { value: (x, y) => x.concat(y), default: () => [] },
    userPreferences: { value: (x, y) => y ?? x, default: () => ({}) },
  },
})
  .addNode('loadPreferences', async (state, config) => {
    // Load user preferences from store
    const [prefs] = await store.batch([
      {
        namespace: ['user', 'preferences'],
        key: 'theme',
      }
    ], config);

    return { userPreferences: prefs?.value || {} };
  })
  .addNode('saveHistory', async (state, config) => {
    // Save conversation history
    await store.batch([
      {
        namespace: ['user', 'history'],
        key: `conv-${Date.now()}`,
        value: { messages: state.messages },
      }
    ], config);

    return {};
  });

// Compile with store
const app = workflow.compile({ store });

// Execute with user ID
const result = await app.invoke(
  { messages: ['Hello'] },
  { configurable: { user_id: 'user-123' } }
);
```

## Configuration Options

### DynamoDBStoreOptions

```typescript
interface DynamoDBStoreOptions {
  /** Name of the DynamoDB table for memory storage */
  memoryTableName: string;

  /** Optional: Bedrock embeddings for semantic search */
  embedding?: BedrockEmbeddings;

  /** Optional: TTL in days for automatic expiration (1-1825 days) */
  ttlDays?: number;

  /** Optional: AWS SDK DynamoDB client configuration */
  clientConfig?: {
    region?: string;
    credentials?: AwsCredentialIdentity;
    endpoint?: string;
    // ... other AWS SDK config
  };
}
```

## Operation Types

### GetOperation

Retrieve a single item from the store:

```typescript
interface GetOperation {
  namespace: string[];  // Hierarchical namespace
  key: string;          // Item key
}
```

### PutOperation

Store an item in the store:

```typescript
interface PutOperation {
  namespace: string[];  // Hierarchical namespace
  key: string;          // Item key
  value: any;           // Any JSON-serializable value
  index?: string[];     // Optional: JSONPath expressions for embedding
}
```

### SearchOperation

Search for items with optional filters and semantic search:

```typescript
interface SearchOperation {
  namespacePrefix: string[];  // Namespace prefix to search within
  filter?: Record<string, Record<string, any>>;  // Optional filters
  query?: string;             // Optional: Semantic query (requires embeddings)
  limit?: number;             // Max items to return (default: 100)
  offset?: number;            // Offset for pagination (default: 0)
}
```

### ListNamespacesOperation

List unique namespaces:

```typescript
interface ListNamespacesOperation {
  limit?: number;   // Max namespaces to return (default: 100)
  offset?: number;  // Offset for pagination (default: 0)
}
```

## Best Practices

### Namespace Design

```typescript
// ✅ Good - Clear hierarchy
['user', userId, 'preferences', 'ui']
['documents', 'category', 'subcategory']

// ❌ Bad - Flat structure limits organization
['user-preferences-ui']
['documents-category-subcategory']

// ✅ Good - Consistent levels
['entity-type', 'entity-id', 'data-type']

// ❌ Bad - Inconsistent depth
['users', userId]
['products', category, subcategory, productId, 'details']
```

### Key Naming

```typescript
// ✅ Good - Descriptive, unique keys
key: 'email-notifications-enabled'
key: 'last-login-timestamp'
key: `session-${sessionId}`

// ❌ Bad - Generic, collision-prone
key: 'data'
key: 'value'
key: 'item'
```

### Value Structure

```typescript
// ✅ Good - Structured, typed data
value: {
  emailEnabled: true,
  frequency: 'daily',
  lastSent: '2024-01-15T10:00:00Z',
}

// ❌ Bad - Unstructured strings
value: 'true,daily,2024-01-15T10:00:00Z'

// ✅ Good - Include metadata
value: {
  data: { ... },
  metadata: {
    version: 2,
    source: 'user-input',
    confidence: 0.95,
  },
}
```

### Error Handling

```typescript
import { DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';

try {
  const results = await store.batch(operations, config);
} catch (error) {
  if (error.message.includes('user_id is required')) {
    // Handle missing user_id
    console.error('User ID must be provided in config');
  } else if (error.name === 'ValidationError') {
    // Handle validation errors
    console.error('Invalid operation parameters:', error.message);
  } else if (error.name === 'ResourceNotFoundException') {
    // Handle missing table
    console.error('DynamoDB table not found');
  } else if (error.message.includes('iteration limit')) {
    // Handle query limits
    console.error('Search query too broad, add more filters');
  } else {
    // Handle other errors
    console.error('Store operation failed:', error);
  }
}
```

### Performance Optimization

```typescript
// ✅ Good - Batch multiple operations
const results = await store.batch([
  { namespace: ['a'], key: 'k1' },
  { namespace: ['b'], key: 'k2' },
  { namespace: ['c'], key: 'k3' },
], config);

// ❌ Bad - Multiple individual calls
const r1 = await store.batch([{ namespace: ['a'], key: 'k1' }], config);
const r2 = await store.batch([{ namespace: ['b'], key: 'k2' }], config);
const r3 = await store.batch([{ namespace: ['c'], key: 'k3' }], config);

// ✅ Good - Use specific namespace prefixes
const [results] = await store.batch([
  {
    namespacePrefix: ['user', userId, 'preferences'],
    limit: 10,
  }
], config);

// ❌ Bad - Broad searches without filters
const [results] = await store.batch([
  {
    namespacePrefix: [],  // Searches everything
    limit: 1000,
  }
], config);
```

### TTL Strategy

```typescript
// Short-lived session data
const sessionStore = new DynamoDBStore({
  memoryTableName: 'sessions',
  ttlDays: 1, // 24 hours
});

// Medium-term user preferences
const preferencesStore = new DynamoDBStore({
  memoryTableName: 'preferences',
  ttlDays: 90, // 3 months
});

// Long-term knowledge base
const knowledgeStore = new DynamoDBStore({
  memoryTableName: 'knowledge',
  ttlDays: 365, // 1 year
});

// Permanent data (no TTL)
const permanentStore = new DynamoDBStore({
  memoryTableName: 'permanent',
  // ttlDays omitted
});
```

## Limitations

- **User ID**: Required in config, max 256 characters
- **Namespace**: Max 20 levels, each part max 256 characters, cannot contain `#` or `/`
- **Key**: Max 1024 characters, cannot contain `#`
- **Value**: Max 400 KB per item (DynamoDB limit)
- **Batch Size**: Max 100 operations per batch call
- **Pagination**: Max limit 1000, max offset 10000
- **Embeddings**: Max 100 embeddings per batch, max 10000 dimensions per embedding
- **Filter Expressions**: Max 50 filter conditions
- **Search Iterations**: Max 100 query iterations (safety limit)

## Performance Tips

1. **Use Batch Operations**: Combine multiple operations into a single batch call
2. **Narrow Namespace Prefixes**: Use specific prefixes to reduce query scope
3. **Add Filters**: Use filter expressions to reduce data transfer
4. **Pagination**: Use reasonable limits and offsets for large result sets
5. **TTL Management**: Set appropriate TTL to automatically clean up old data
6. **Monitor Costs**: Use DynamoDB on-demand billing for variable workloads
7. **Semantic Search**: Only use embeddings when semantic similarity is needed
8. **Index Fields**: Only index fields that will be used for semantic search

## API Reference

For detailed API documentation, see:

- [DynamoDBStore Class](./classes/DynamoDBStore.md)
- [DynamoDBStoreOptions Interface](./interfaces/DynamoDBStoreOptions.md)

## Related Documentation

- [DynamoDBSaver](./checkpointer.md) - Checkpoint storage for workflows
- [DynamoDBChatMessageHistory](./history.md) - Chat message history
- [LangGraph Documentation](https://langchain-ai.github.io/langgraphjs/)
