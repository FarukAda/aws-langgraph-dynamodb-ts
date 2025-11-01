# DynamoDBSaver - Checkpoint Storage

The `DynamoDBSaver` provides persistent checkpoint storage for LangGraph workflows. It allows workflows to save their execution state at various points and resume from those checkpoints, enabling features like error recovery, workflow continuation, and long-running processes.

## Overview

The checkpointer module implements the `BaseCheckpointSaver` interface from `@langchain/langgraph-checkpoint`, storing checkpoints and pending writes in DynamoDB tables. Each checkpoint represents a snapshot of the workflow state at a specific point in time.

### Key Features

- 🔄 **Checkpoint Persistence**: Save and retrieve workflow state
- ⏱️ **Pending Writes**: Store writes that should be executed on checkpoint resume
- 🔗 **Checkpoint Chains**: Support for parent-child checkpoint relationships
- 🧵 **Thread Isolation**: Organize checkpoints by thread ID
- 📁 **Namespace Support**: Group related checkpoints within a thread
- ♻️ **TTL Support**: Automatic checkpoint expiration
- 🔁 **Retry Logic**: Built-in retry for transient DynamoDB errors

## Installation

```bash
npm install @farukada/aws-langgraph-dynamodb-ts @langchain/langgraph @langchain/langgraph-checkpoint
```

## Table Schema

### Checkpoints Table

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `thread_id` | String | Partition Key | Unique identifier for the workflow thread |
| `checkpoint_id` | String | Sort Key | Unique checkpoint identifier (UUID) |
| `checkpoint_ns` | String | - | Optional namespace for grouping checkpoints |
| `parent_checkpoint_id` | String | - | Reference to parent checkpoint (for chains) |
| `checkpoint` | Binary | - | Serialized checkpoint data |
| `metadata` | Binary | - | Serialized metadata |
| `type` | String | - | Serialization type ('json' or 'binary') |
| `ttl` | Number | - | Optional expiration timestamp (Unix epoch) |

### Writes Table

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `thread_id_checkpoint_id_checkpoint_ns` | String | Partition Key | Composite key: `{thread_id}:::{checkpoint_id}:::{checkpoint_ns}` |
| `task_id_idx` | String | Sort Key | Composite key: `{task_id}:::{idx}` |
| `channel` | String | - | Channel name for the write operation |
| `type` | String | - | Serialization type ('json' or 'binary') |
| `value` | Binary | - | Serialized write value |
| `ttl` | Number | - | Optional expiration timestamp |

## Basic Usage

### Creating a Checkpointer

```typescript
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

const checkpointer = new DynamoDBSaver({
  checkpointsTableName: 'langgraph-checkpoints',
  writesTableName: 'langgraph-writes',
  ttlDays: 30, // Optional: Auto-delete after 30 days
  clientConfig: {
    region: 'us-east-1',
    // ... other AWS SDK config
  },
});
```

### Using with LangGraph

```typescript
import { StateGraph } from '@langchain/langgraph';

interface WorkflowState {
  messages: string[];
  step: number;
}

const workflow = new StateGraph<WorkflowState>({
  channels: {
    messages: { value: (x, y) => x.concat(y), default: () => [] },
    step: { value: (x, y) => y ?? x, default: () => 0 },
  },
})
  .addNode('process', async (state) => {
    // Processing logic
    return { step: state.step + 1 };
  })
  .addEdge('__start__', 'process')
  .addEdge('process', '__end__');

// Compile with checkpointer
const app = workflow.compile({ checkpointer });

// Execute with thread ID - state is automatically saved
const result = await app.invoke(
  { messages: ['Hello'], step: 0 },
  { configurable: { thread_id: 'conversation-123' } }
);

// Resume from checkpoint
const resumed = await app.invoke(
  { messages: ['Continue'] },
  { configurable: { thread_id: 'conversation-123' } }
);
```

## Advanced Usage

### Checkpoint with Namespace

```typescript
// Save checkpoint to specific namespace
await app.invoke(input, {
  configurable: {
    thread_id: 'workflow-123',
    checkpoint_ns: 'production',
  },
});

// Resume from namespace
await app.invoke(input, {
  configurable: {
    thread_id: 'workflow-123',
    checkpoint_ns: 'production',
    checkpoint_id: 'checkpoint-456', // Optional: specific checkpoint
  },
});
```

### Listing Checkpoints

```typescript
// List all checkpoints for a thread
const checkpoints = await checkpointer.list({
  configurable: { thread_id: 'workflow-123' },
});

// List with limit and before filter
const recent = await checkpointer.list({
  configurable: { thread_id: 'workflow-123' },
  limit: 10,
  before: { configurable: { checkpoint_id: 'some-checkpoint-id' } },
});

console.log(checkpoints);
// [
//   {
//     config: { configurable: { thread_id, checkpoint_id, checkpoint_ns } },
//     checkpoint: { ... },
//     metadata: { ... },
//     parentConfig: { ... }
//   },
//   ...
// ]
```

### Deleting Thread Data

```typescript
// Delete all checkpoints and writes for a thread
await checkpointer.deleteThread('conversation-123');
```

## Configuration Options

### DynamoDBSaverOptions

```typescript
interface DynamoDBSaverOptions {
  /** Name of the DynamoDB table for checkpoints */
  checkpointsTableName: string;

  /** Name of the DynamoDB table for pending writes */
  writesTableName: string;

  /** Optional: TTL in days for automatic expiration (1-10000) */
  ttlDays?: number;

  /** Optional: AWS SDK DynamoDB client configuration */
  clientConfig?: {
    region?: string;
    credentials?: AwsCredentialIdentity;
    endpoint?: string;
    // ... other AWS SDK config
  };

  /** Optional: Custom serialization implementation */
  serde?: SerializerProtocol;
}
```

## Checkpoint Structure

### RunnableConfig

The configuration object passed to checkpointer methods:

```typescript
interface RunnableConfig {
  configurable: {
    /** Required: Thread identifier */
    thread_id: string;

    /** Optional: Specific checkpoint ID to retrieve */
    checkpoint_id?: string;

    /** Optional: Namespace for organizing checkpoints (defaults to "") */
    checkpoint_ns?: string;
  };
}
```

### CheckpointTuple

The data structure returned by `getTuple()`:

```typescript
interface CheckpointTuple {
  /** Configuration identifying this checkpoint */
  config: RunnableConfig;

  /** The checkpoint data */
  checkpoint: Checkpoint;

  /** Checkpoint metadata */
  metadata: CheckpointMetadata;

  /** Optional: Configuration of parent checkpoint */
  parentConfig?: RunnableConfig;

  /** Optional: Pending writes to be applied */
  pendingWrites?: PendingWrite[];
}
```

## Best Practices

### Thread ID Organization

```typescript
// Use descriptive, hierarchical thread IDs
const threadId = `user:${userId}:conversation:${conversationId}`;
const threadId = `workflow:${workflowType}:${instanceId}`;
const threadId = `agent:${agentId}:task:${taskId}:${timestamp}`;
```

### Checkpoint Namespace Strategy

```typescript
// Organize by environment
checkpoint_ns: process.env.NODE_ENV; // 'development', 'staging', 'production'

// Organize by version
checkpoint_ns: `v${workflowVersion}`;

// Organize by feature
checkpoint_ns: 'feature-flags-enabled';
```

### Error Handling

```typescript
import { DynamoDBSaver } from '@farukada/aws-langgraph-dynamodb-ts';

try {
  const result = await app.invoke(input, config);
} catch (error) {
  if (error.name === 'ValidationError') {
    // Handle validation errors (invalid thread_id, etc.)
    console.error('Invalid configuration:', error.message);
  } else if (error.name === 'ResourceNotFoundException') {
    // Handle missing table
    console.error('DynamoDB table not found');
  } else {
    // Handle other errors
    console.error('Checkpoint error:', error);
  }
}
```

### TTL Considerations

```typescript
// Short-lived workflows (development/testing)
const devCheckpointer = new DynamoDBSaver({
  checkpointsTableName: 'dev-checkpoints',
  writesTableName: 'dev-writes',
  ttlDays: 7, // Clean up after 1 week
});

// Long-running workflows (production)
const prodCheckpointer = new DynamoDBSaver({
  checkpointsTableName: 'prod-checkpoints',
  writesTableName: 'prod-writes',
  ttlDays: 365, // Keep for 1 year
});

// No TTL (manual cleanup)
const permanentCheckpointer = new DynamoDBSaver({
  checkpointsTableName: 'permanent-checkpoints',
  writesTableName: 'permanent-writes',
  // ttlDays omitted - no automatic expiration
});
```

## Limitations

- **Thread ID**: Max 256 characters, no separator `:::`, no control characters
- **Checkpoint ID**: Max 256 characters, no separator `:::`, no control characters
- **Checkpoint Namespace**: Max 256 characters, no separator `:::`
- **List Limit**: Max 1000 checkpoints per query
- **Writes Count**: Max 1000 pending writes per checkpoint
- **Batch Size**: Writes are batched in groups of 25 for DynamoDB

## Performance Tips

1. **Use Namespaces**: Organize checkpoints by namespace for efficient querying
2. **Limit List Queries**: Use pagination with `limit` parameter
3. **Clean Up Threads**: Delete completed workflow threads to reduce storage costs
4. **Enable TTL**: Configure appropriate TTL for automatic cleanup
5. **Monitor Costs**: Use DynamoDB on-demand billing for variable workloads

## API Reference

For detailed API documentation, see:

- [DynamoDBSaver Class](./classes/DynamoDBSaver.md)
- [DynamoDBSaverOptions Interface](./interfaces/DynamoDBSaverOptions.md)

## Related Documentation

- [DynamoDBStore](./store.md) - Memory/knowledge storage
- [DynamoDBChatMessageHistory](./history.md) - Chat message history
- [LangGraph Documentation](https://langchain-ai.github.io/langgraphjs/)
