# @farukada/aws-langgraph-dynamodb-ts

[![npm version](https://badge.fury.io/js/@farukada%2Faws-langgraph-dynamodb-ts.svg)](https://badge.fury.io/js/@farukada%2Faws-langgraph-dynamodb-ts)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.5.3-blue)](https://www.typescriptlang.org/)
[![AWS SDK](https://img.shields.io/badge/AWS%20SDK-v3-orange)](https://aws.amazon.com/sdk-for-javascript/)

> ⚠️ **Active Development**: This package is currently in active development. APIs may change between versions.

AWS DynamoDB implementation for LangGraph Memory Store and Checkpoint Saver in TypeScript. This package provides persistent storage solutions for LangGraph applications using AWS DynamoDB, enabling state management and memory persistence for AI agents and conversational workflows.

## Features

- 🔄 **Checkpoint Saver**: Persistent checkpoint storage for LangGraph state management
- 💾 **Memory Store**: Long-term memory storage with namespace support
- 🔍 **Semantic Search**: Optional vector embeddings via AWS Bedrock for semantic search capabilities
- ⚡ **Optimized Performance**: Efficient querying with composite keys and batch operations
- 🔒 **Type-Safe**: Full TypeScript support with comprehensive type definitions
- ♻️ **TTL Support**: Automatic data expiration with configurable Time-To-Live
- 🔁 **Retry Logic**: Built-in retry mechanisms for transient DynamoDB errors
- 🧪 **Well-Tested**: Comprehensive test coverage with Jest

## Installation

```bash
npm install @farukada/aws-langgraph-dynamodb-ts
```

### Peer Dependencies

Make sure you have the required peer dependencies installed:

```bash
npm install @aws-sdk/client-dynamodb @aws-sdk/lib-dynamodb @langchain/core @langchain/langgraph @langchain/langgraph-checkpoint
```

For semantic search capabilities, also install:

```bash
npm install @langchain/aws
```

## Infrastructure Setup

Before using this package, you need to create the required DynamoDB tables. Below are examples using both AWS CDK and Terraform.

### AWS CDK (TypeScript)

```typescript
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export class LangGraphDynamoDBStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Checkpoints Table
    const checkpointsTable = new dynamodb.Table(this, 'LangGraphCheckpoints', {
      tableName: 'langgraph-checkpoints',
      partitionKey: {
        name: 'thread_id',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'checkpoint_id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change for production
      pointInTimeRecovery: true,
    });

    // Writes Table
    const writesTable = new dynamodb.Table(this, 'LangGraphWrites', {
      tableName: 'langgraph-writes',
      partitionKey: {
        name: 'thread_id_checkpoint_id_checkpoint_ns',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'task_id_idx',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change for production
      pointInTimeRecovery: true,
    });

    // Memory Store Table
    const memoryTable = new dynamodb.Table(this, 'LangGraphMemory', {
      tableName: 'langgraph-memory',
      partitionKey: {
        name: 'user_id',
        type: dynamodb.AttributeType.STRING,
      },
      sortKey: {
        name: 'namespace_key',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: cdk.RemovalPolicy.DESTROY, // Change for production
      pointInTimeRecovery: true,
    });

    // Output table names
    new cdk.CfnOutput(this, 'CheckpointsTableName', {
      value: checkpointsTable.tableName,
      description: 'Checkpoints table name',
    });

    new cdk.CfnOutput(this, 'WritesTableName', {
      value: writesTable.tableName,
      description: 'Writes table name',
    });

    new cdk.CfnOutput(this, 'MemoryTableName', {
      value: memoryTable.tableName,
      description: 'Memory table name',
    });
  }
}
```

### Terraform

```hcl
# Checkpoints Table
resource "aws_dynamodb_table" "langgraph_checkpoints" {
  name           = "langgraph-checkpoints"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "thread_id"
  range_key      = "checkpoint_id"

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

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name        = "LangGraph Checkpoints"
    Environment = "production"
  }
}

# Writes Table
resource "aws_dynamodb_table" "langgraph_writes" {
  name           = "langgraph-writes"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "thread_id_checkpoint_id_checkpoint_ns"
  range_key      = "task_id_idx"

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

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name        = "LangGraph Writes"
    Environment = "production"
  }
}

# Memory Store Table
resource "aws_dynamodb_table" "langgraph_memory" {
  name           = "langgraph-memory"
  billing_mode   = "PAY_PER_REQUEST"
  hash_key       = "user_id"
  range_key      = "namespace_key"

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

  point_in_time_recovery {
    enabled = true
  }

  tags = {
    Name        = "LangGraph Memory"
    Environment = "production"
  }
}

# Outputs
output "checkpoints_table_name" {
  value       = aws_dynamodb_table.langgraph_checkpoints.name
  description = "Checkpoints table name"
}

output "writes_table_name" {
  value       = aws_dynamodb_table.langgraph_writes.name
  description = "Writes table name"
}

output "memory_table_name" {
  value       = aws_dynamodb_table.langgraph_memory.name
  description = "Memory table name"
}
```

## Usage

### DynamoDBSaver (Checkpoint Saver)

The checkpoint saver enables persistent state management for LangGraph workflows.

#### Standalone Usage

```typescript
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

// Initialize the saver
const checkpointer = new DynamoDBSaver({
  checkpointsTableName: 'langgraph-checkpoints',
  writesTableName: 'langgraph-writes',
  ttlDays: 30, // Optional: Auto-delete after 30 days
  clientConfig: {
    region: 'us-east-1',
    // Add other AWS SDK configurations as needed
  },
});

// Save a checkpoint
await checkpointer.put(
  {
    configurable: {
      thread_id: 'conversation-123',
      checkpoint_ns: 'default',
    },
  },
  checkpoint,
  metadata,
  {}
);

// Retrieve a checkpoint
const tuple = await checkpointer.getTuple({
  configurable: {
    thread_id: 'conversation-123',
    checkpoint_id: 'checkpoint-456',
  },
});

// List checkpoints for a thread
for await (const checkpoint of checkpointer.list(
  { configurable: { thread_id: 'conversation-123' } },
  { limit: 10 }
)) {
  console.log(checkpoint);
}

// Delete a thread and all its checkpoints
await checkpointer.deleteThread('conversation-123');
```

#### With LangGraph

```typescript
import { StateGraph } from '@langchain/langgraph';
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

// Create the checkpointer
const checkpointer = new DynamoDBSaver({
  checkpointsTableName: 'langgraph-checkpoints',
  writesTableName: 'langgraph-writes',
  ttlDays: 30,
});

// Define your state interface
interface AgentState {
  messages: string[];
  step: number;
}

// Create a graph with checkpoint support
const workflow = new StateGraph<AgentState>({
  channels: {
    messages: {
      value: (x: string[], y: string[]) => x.concat(y),
      default: () => [],
    },
    step: {
      value: (x?: number, y?: number) => y ?? x ?? 0,
      default: () => 0,
    },
  },
})
  .addNode('processMessage', async (state: AgentState) => {
    // Your processing logic here
    return {
      messages: [...state.messages, 'Processed message'],
      step: state.step + 1,
    };
  })
  .addEdge('__start__', 'processMessage')
  .addEdge('processMessage', '__end__');

// Compile with checkpointer
const app = workflow.compile({ checkpointer });

// Run with a specific thread
const config = {
  configurable: {
    thread_id: 'user-session-123',
  },
};

const result = await app.invoke(
  { messages: ['Hello'], step: 0 },
  config
);

// Resume from checkpoint later
const resumed = await app.invoke(
  { messages: ['Continue'], step: result.step },
  config
);
```

### DynamoDBStore (Memory Store)

The memory store provides long-term storage for agent memories with optional semantic search.

#### Standalone Usage

```typescript
import { DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';

// Initialize without embeddings (keyword search only)
const store = new DynamoDBStore({
  memoryTableName: 'langgraph-memory',
  ttlDays: 90,
  clientConfig: {
    region: 'us-east-1',
  },
});

// Store a memory
await store.batch(
  [
    {
      namespace: ['user', 'preferences'],
      key: 'theme',
      value: { color: 'dark', fontSize: 14 },
    },
  ],
  {
    configurable: { user_id: 'user-123' },
  }
);

// Retrieve a memory
const [memory] = await store.batch(
  [
    {
      namespace: ['user', 'preferences'],
      key: 'theme',
    },
  ],
  {
    configurable: { user_id: 'user-123' },
  }
);

console.log(memory); // { key: 'theme', namespace: ['user', 'preferences'], value: {...}, ... }

// Search memories
const [results] = await store.batch(
  [
    {
      namespacePrefix: ['user'],
      limit: 10,
      offset: 0,
      filter: {
        'value.color': { $eq: 'dark' },
      },
    },
  ],
  {
    configurable: { user_id: 'user-123' },
  }
);

// List namespaces
const [namespaces] = await store.batch(
  [
    {
      limit: 100,
      offset: 0,
    },
  ],
  {
    configurable: { user_id: 'user-123' },
  }
);
```

#### With Semantic Search (Bedrock Embeddings)

```typescript
import { DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';
import { BedrockEmbeddings } from '@langchain/aws';

// Initialize with embeddings for semantic search
const embeddings = new BedrockEmbeddings({
  region: 'us-east-1',
  model: 'amazon.titan-embed-text-v1',
});

const store = new DynamoDBStore({
  memoryTableName: 'langgraph-memory',
  embedding: embeddings,
  ttlDays: 90,
  clientConfig: {
    region: 'us-east-1',
  },
});

// Store memories with semantic indexing
await store.batch(
  [
    {
      namespace: ['documents'],
      key: 'doc1',
      value: {
        title: 'Introduction to AI',
        content: 'Artificial intelligence is transforming the world...',
      },
      index: ['$.content'], // JSONPath to fields to embed
    },
  ],
  {
    configurable: { user_id: 'user-123' },
  }
);

// Semantic search with query
const [semanticResults] = await store.batch(
  [
    {
      namespacePrefix: ['documents'],
      query: 'machine learning basics', // Semantic query
      limit: 5,
      offset: 0,
    },
  ],
  {
    configurable: { user_id: 'user-123' },
  }
);

// Results include similarity scores
semanticResults.forEach(result => {
  console.log(`Score: ${result.score}, Doc: ${result.item.value.title}`);
});
```

#### With LangGraph Agent

```typescript
import { StateGraph } from '@langchain/langgraph';
import { DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';
import { BedrockEmbeddings } from '@langchain/aws';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

const embeddings = new BedrockEmbeddings({
  region: 'us-east-1',
  model: 'amazon.titan-embed-text-v1',
});

const store = new DynamoDBStore({
  memoryTableName: 'langgraph-memory',
  embedding: embeddings,
});

interface AgentState {
  messages: string[];
  relevantMemories: any[];
}

const workflow = new StateGraph<AgentState>({
  channels: {
    messages: {
      value: (x: string[], y: string[]) => x.concat(y),
      default: () => [],
    },
    relevantMemories: {
      value: (x: any[], y: any[]) => y ?? x ?? [],
      default: () => [],
    },
  },
})
  .addNode('fetchMemories', async (state: AgentState, config?: LangGraphRunnableConfig) => {
    // Access store from config
    const memoryStore = config?.store;
    if (!memoryStore) {
      throw new Error('Store not available in config');
    }

    // Semantic search for relevant memories
    const [memories] = await memoryStore.batch(
      [
        {
          namespacePrefix: ['conversations'],
          query: state.messages[state.messages.length - 1],
          limit: 5,
          offset: 0,
        },
      ],
      config
    );

    return {
      ...state,
      relevantMemories: memories.map(m => m.item),
    };
  })
  .addNode('processWithMemory', async (state: AgentState, config?: LangGraphRunnableConfig) => {
    // Access store from config
    const memoryStore = config?.store;
    if (!memoryStore) {
      throw new Error('Store not available in config');
    }

    // Use memories in your agent logic
    console.log('Relevant memories:', state.relevantMemories);
    
    // Store new memory
    await memoryStore.batch(
      [
        {
          namespace: ['conversations'],
          key: `msg-${Date.now()}`,
          value: {
            message: state.messages[state.messages.length - 1],
            timestamp: new Date().toISOString(),
          },
          index: ['$.message'],
        },
      ],
      config
    );

    return {
      ...state,
      messages: [...state.messages, 'Processed with memory context'],
    };
  })
  .addEdge('__start__', 'fetchMemories')
  .addEdge('fetchMemories', 'processWithMemory')
  .addEdge('processWithMemory', '__end__');

// Compile with store - makes it available in config.store
const app = workflow.compile({ store });
```

### Complete Example: Agent with Memory and Checkpointing

```typescript
import { StateGraph } from '@langchain/langgraph';
import { DynamoDBSaver, DynamoDBStore } from '@farukada/aws-langgraph-dynamodb-ts';
import { BedrockEmbeddings } from '@langchain/aws';
import type { LangGraphRunnableConfig } from '@langchain/langgraph';

// Setup infrastructure components
const embeddings = new BedrockEmbeddings({
  region: 'us-east-1',
  model: 'amazon.titan-embed-text-v1',
});

const checkpointer = new DynamoDBSaver({
  checkpointsTableName: 'langgraph-checkpoints',
  writesTableName: 'langgraph-writes',
  ttlDays: 30,
});

const store = new DynamoDBStore({
  memoryTableName: 'langgraph-memory',
  embedding: embeddings,
  ttlDays: 90,
});

// Define agent state
interface ConversationState {
  messages: string[];
  memories: any[];
  userId: string;
}

// Create workflow
const workflow = new StateGraph<ConversationState>({
  channels: {
    messages: {
      value: (x: string[], y: string[]) => x.concat(y),
      default: () => [],
    },
    memories: {
      value: (x: any[], y: any[]) => y ?? x ?? [],
      default: () => [],
    },
    userId: {
      value: (x?: string, y?: string) => y ?? x ?? '',
      default: () => '',
    },
  },
})
  .addNode('loadMemories', async (state: ConversationState, config?: LangGraphRunnableConfig) => {
    // Access store from config
    const memoryStore = config?.store;
    if (!memoryStore) {
      throw new Error('Store not available in config');
    }

    const [memories] = await memoryStore.batch(
      [
        {
          namespacePrefix: ['user', state.userId],
          query: state.messages[state.messages.length - 1],
          limit: 3,
          offset: 0,
        },
      ],
      config
    );

    return { ...state, memories: memories.map(m => m.item) };
  })
  .addNode('processMessage', async (state: ConversationState, config?: LangGraphRunnableConfig) => {
    // Access store from config
    const memoryStore = config?.store;
    if (!memoryStore) {
      throw new Error('Store not available in config');
    }

    // Your AI processing logic here
    const response = `Processed: ${state.messages[state.messages.length - 1]}`;
    
    // Store interaction as memory
    await memoryStore.batch(
      [
        {
          namespace: ['user', state.userId, 'interactions'],
          key: `interaction-${Date.now()}`,
          value: {
            query: state.messages[state.messages.length - 1],
            response: response,
            timestamp: new Date().toISOString(),
          },
          index: ['$.query', '$.response'],
        },
      ],
      config
    );

    return {
      ...state,
      messages: [...state.messages, response],
    };
  })
  .addEdge('__start__', 'loadMemories')
  .addEdge('loadMemories', 'processMessage')
  .addEdge('processMessage', '__end__');

// Compile with BOTH checkpointer and store
const app = workflow.compile({ 
  checkpointer,
  store,
});

// Run conversation with persistence
const userId = 'user-123';
const threadId = 'conversation-456';

const result = await app.invoke(
  {
    messages: ['What is machine learning?'],
    memories: [],
    userId: userId,
  },
  {
    configurable: {
      thread_id: threadId,
      user_id: userId,
    },
  }
);

console.log('Agent Response:', result);

// Later, resume the conversation
const continued = await app.invoke(
  {
    messages: ['Tell me more about neural networks'],
    memories: [],
    userId: userId,
  },
  {
    configurable: {
      thread_id: threadId,
      user_id: userId,
    },
  }
);
```

## Configuration Options

### DynamoDBSaver Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `checkpointsTableName` | `string` | Yes | Name of the DynamoDB table for checkpoints |
| `writesTableName` | `string` | Yes | Name of the DynamoDB table for pending writes |
| `ttlDays` | `number` | No | TTL in days (1-1825), enables automatic expiration |
| `clientConfig` | `DynamoDBClientConfig` | No | AWS SDK DynamoDB client configuration |
| `serde` | `SerializerProtocol` | No | Custom serializer for checkpoint data |

### DynamoDBStore Options

| Option | Type | Required | Description |
|--------|------|----------|-------------|
| `memoryTableName` | `string` | Yes | Name of the DynamoDB table for memory storage |
| `embedding` | `BedrockEmbeddings` | No | Bedrock embeddings for semantic search |
| `ttlDays` | `number` | No | TTL in days (1-1825), enables automatic expiration |
| `clientConfig` | `DynamoDBClientConfig` | No | AWS SDK DynamoDB client configuration |

## Advanced Features

### Filter Operations

The store supports JSONPath-based filtering:

```typescript
const [results] = await store.batch(
  [
    {
      namespacePrefix: ['products'],
      limit: 10,
      offset: 0,
      filter: {
        'value.price': { $gte: 10, $lte: 100 },
        'value.category': { $eq: 'electronics' },
        'value.inStock': { $ne: false },
      },
    },
  ],
  { configurable: { user_id: 'user-123' } }
);
```

Supported operators:
- `$eq`: Equal
- `$ne`: Not equal
- `$gt`: Greater than
- `$gte`: Greater than or equal
- `$lt`: Less than
- `$lte`: Less than or equal

### Namespace Organization

Organize memories hierarchically:

```typescript
// User preferences
['user', 'userId', 'preferences']

// Conversation history
['user', 'userId', 'conversations', 'threadId']

// Documents
['documents', 'category', 'subcategory']

// Facts about topics
['knowledge', 'topic', 'subtopic']
```

### Batch Operations

Execute multiple operations efficiently:

```typescript
const results = await store.batch(
  [
    // Get operation
    { namespace: ['docs'], key: 'doc1' },
    
    // Put operation
    { namespace: ['docs'], key: 'doc2', value: { content: 'text' } },
    
    // Search operation
    { namespacePrefix: ['docs'], limit: 10, offset: 0 },
    
    // List namespaces
    { limit: 100, offset: 0 },
  ],
  { configurable: { user_id: 'user-123' } }
);
```

## Error Handling

The package includes built-in retry logic for transient DynamoDB errors:

```typescript
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

try {
  const checkpointer = new DynamoDBSaver({
    checkpointsTableName: 'langgraph-checkpoints',
    writesTableName: 'langgraph-writes',
  });

  await checkpointer.put(config, checkpoint, metadata, {});
} catch (error) {
  if (error.name === 'ValidationError') {
    console.error('Invalid input:', error.message);
  } else if (error.name === 'ResourceNotFoundException') {
    console.error('Table not found:', error.message);
  } else {
    console.error('Unexpected error:', error);
  }
}
```

## IAM Permissions

Your application needs the following IAM permissions:

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
        "dynamodb:Scan",
        "dynamodb:BatchWriteItem"
      ],
      "Resource": [
        "arn:aws:dynamodb:REGION:ACCOUNT:table/langgraph-checkpoints",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/langgraph-writes",
        "arn:aws:dynamodb:REGION:ACCOUNT:table/langgraph-memory"
      ]
    },
    {
      "Effect": "Allow",
      "Action": [
        "bedrock:InvokeModel"
      ],
      "Resource": "arn:aws:bedrock:REGION::foundation-model/amazon.titan-embed-text-v1"
    }
  ]
}
```

## Performance Considerations

- **Batch Operations**: Use batch operations to reduce API calls
- **TTL**: Configure TTL to automatically clean up old data
- **Billing Mode**: Use PAY_PER_REQUEST for variable workloads, PROVISIONED for predictable traffic
- **Point-in-Time Recovery**: Enable for production workloads
- **Semantic Search**: Embedding generation adds latency; cache when possible

## Testing

Run the test suite:

```bash
npm test
```

Run tests with coverage:

```bash
npm test -- --coverage
```

## Contributing

Contributions are welcome! Since this package is in active development, please:

1. Check existing issues or create a new one
2. Fork the repository
3. Create a feature branch
4. Make your changes with tests
5. Submit a pull request

## License

MIT © [FarukAda](https://github.com/farukada)

## Links

- [GitHub Repository](https://github.com/farukada/aws-langgraph-dynamodb-ts)
- [npm Package](https://www.npmjs.com/package/@farukada/aws-langgraph-dynamodb-ts)
- [Issue Tracker](https://github.com/farukada/aws-langgraph-dynamodb-ts/issues)
- [LangGraph Documentation](https://langchain-ai.github.io/langgraphjs/)
- [AWS DynamoDB Documentation](https://docs.aws.amazon.com/dynamodb/)
- [AWS Bedrock Documentation](https://docs.aws.amazon.com/bedrock/)

## Acknowledgments

Built with:
- [LangGraph](https://github.com/langchain-ai/langgraphjs) - Framework for building stateful AI agents
- [AWS SDK for JavaScript](https://aws.amazon.com/sdk-for-javascript/) - AWS service integration
- [LangChain](https://github.com/langchain-ai/langchainjs) - LLM application framework

---

**Note**: This package is under active development. Star the repository on GitHub to stay updated with new features and improvements!

