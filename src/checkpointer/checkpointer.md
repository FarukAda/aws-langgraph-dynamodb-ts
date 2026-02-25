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
- ♻️ **TTL Support**: Automatic checkpoint expiration (days or seconds)
- 🗜️ **Compression**: Optional gzip compression with smart thresholds
- ☁️ **S3 Offloading**: Transparent S3 offloading for large payloads (>350 KB)
- 🏗️ **Metadata/Payload Split**: Reduced RCU consumption on list queries
- 🔁 **Retry Logic**: Built-in retry with exponential backoff and jitter

## Installation

```bash
npm install @farukada/aws-langgraph-dynamodb-ts @langchain/langgraph @langchain/langgraph-checkpoint
```

## Storage Architecture

### Metadata/Payload Split

Each checkpoint is stored as **two items** in the checkpoints table, written atomically via `transactWrite`:

1. **Metadata item** (SK = `checkpoint_id`) — lightweight; read by `list()` queries
2. **Payload item** (SK = `PAYLOAD#checkpoint_id`) — heavy blob; fetched only by `getTuple()`

This split significantly **reduces RCU consumption** on `list()` queries because only metadata items are scanned. UUID checkpoint IDs (hex chars `0-9`, `a-f`) sort before `PAYLOAD#` in ASCII, so the key condition `checkpoint_id < PAYLOAD#` naturally excludes payload items.

### Storage Decision

```text
Checkpoint < 350 KB → DynamoDB (metadata + payload items)
Checkpoint ≥ 350 KB → S3 (if configured) with DynamoDB reference
```

### Backward Compatibility

The checkpointer supports a **legacy single-item format** where the checkpoint blob is stored inline on the metadata item. Items with an inline `checkpoint` field are read transparently without requiring a separate payload fetch.

## Table Schema

### Checkpoints Table

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `thread_id` | String | Partition Key | Unique identifier for the workflow thread |
| `checkpoint_id` | String | Sort Key | Checkpoint UUID or `PAYLOAD#` prefixed key |
| `checkpoint_ns` | String | - | Optional namespace for grouping checkpoints |
| `parent_checkpoint_id` | String | - | Reference to parent checkpoint (for chains) |
| `type` | String | - | Serialization type ('json' or 'binary') |
| `metadata` | Binary | - | Serialized metadata (on metadata items) |
| `checkpoint` | Binary | - | Serialized checkpoint data (on payload items) |
| `s3_checkpoint_key` | String | - | S3 key reference when checkpoint is offloaded |
| `s3_metadata_key` | String | - | S3 key reference when metadata is offloaded |
| `ttl` | Number | - | Optional expiration timestamp (Unix epoch) |

**Item types:**
- **Metadata item**: SK = `<checkpoint_id>` — contains `metadata`, `type`, `s3_*` references
- **Payload item**: SK = `PAYLOAD#<checkpoint_id>` — contains `checkpoint` binary blob

### Writes Table

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `thread_id_checkpoint_id_checkpoint_ns` | String | Partition Key | Composite key: `{thread_id}:::{checkpoint_id}:::{checkpoint_ns}` |
| `task_id_idx` | String | Sort Key | Composite key: `{task_id}:::{idx}` |
| `channel` | String | - | Channel name for the write operation |
| `type` | String | - | Serialization type ('json' or 'binary') |
| `value` | Binary | - | Serialized write value |
| `s3_value_key` | String | - | S3 key reference when value is offloaded |
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

### Resource Cleanup

```typescript
// Release underlying DynamoDB and S3 client resources when done
// Skips DynamoDB client cleanup if a shared client was injected via options
checkpointer.destroy();
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
// list() returns an AsyncGenerator — use for-await-of
for await (const tuple of checkpointer.list(
  { configurable: { thread_id: 'workflow-123' } },
  { limit: 10 }
)) {
  console.log(`ID: ${tuple.checkpoint.id}`);
  console.log(`Metadata:`, tuple.metadata);
}

// List with before cursor
for await (const tuple of checkpointer.list(
  { configurable: { thread_id: 'workflow-123' } },
  { before: { configurable: { checkpoint_id: 'some-checkpoint-id' } } }
)) {
  console.log(tuple);
}

// List with metadata filter (client-side exact-match)
for await (const tuple of checkpointer.list(
  { configurable: { thread_id: 'workflow-123' } },
  { filter: { source: 'user' } }
)) {
  console.log(tuple);
}
```

### Deleting Thread Data

```typescript
// Delete all checkpoints (metadata + payload items), writes, and S3 objects for a thread
await checkpointer.deleteThread('conversation-123');
```

### Gzip Compression

Reduce DynamoDB item sizes with transparent gzip compression:

```typescript
const checkpointer = new DynamoDBSaver({
  checkpointsTableName: 'langgraph-checkpoints',
  writesTableName: 'langgraph-writes',
  compression: {
    enabled: true,
    minSizeBytes: 1024, // Only compress payloads ≥ 1 KB (default)
    level: 6,           // Gzip level 1-9 (default: 6, balanced)
  },
});
```

Compression is smart:
- Skips payloads below `minSizeBytes` (default: 1 KB)
- Only uses compressed output if it saves ≥ 10% space
- Uses gzip level 6 (balanced speed/ratio) by default
- Auto-detects gzip on decompression for full backward compatibility

### S3 Offloading

Automatically offload large payloads to S3:

```typescript
const checkpointer = new DynamoDBSaver({
  checkpointsTableName: 'langgraph-checkpoints',
  writesTableName: 'langgraph-writes',
  s3OffloadConfig: {
    bucketName: 'my-checkpoints-bucket',
    keyPrefix: 'langgraph/',              // default: 'langgraph-checkpoints/'
    thresholdBytes: 350 * 1024,           // default: 350 KB
    serverSideEncryption: 'aws:kms',      // optional: 'AES256' or 'aws:kms'
    sseKmsKeyId: 'alias/my-key',          // optional: KMS key ID/ARN
    clientConfig: { region: 'us-east-1' },
  },
});
```

When TTL and S3 offloading are both enabled, the library automatically configures an S3 lifecycle expiration rule on the bucket (scoped to the key prefix). This is idempotent — existing rules are preserved.

### Shared Client Injection

```typescript
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocument } from '@aws-sdk/lib-dynamodb';

// Create a shared client for multiple modules
const ddbClient = new DynamoDBClient({ region: 'us-east-1' });
const sharedClient = DynamoDBDocument.from(ddbClient);

const checkpointer = new DynamoDBSaver({
  checkpointsTableName: 'langgraph-checkpoints',
  writesTableName: 'langgraph-writes',
  client: sharedClient, // Takes precedence over clientConfig
});

// destroy() will skip DynamoDB client cleanup since it was injected externally
```

## Configuration Options

### DynamoDBSaverOptions

```typescript
interface DynamoDBSaverOptions {
  /** Name of the DynamoDB table for checkpoints */
  checkpointsTableName: string;

  /** Name of the DynamoDB table for pending writes */
  writesTableName: string;

  /** Optional: TTL in days for automatic expiration (1-1825 days) */
  ttlDays?: number;

  /** Optional: TTL in seconds (overrides ttlDays if both set) */
  ttlSeconds?: number;

  /** Optional: Compression configuration */
  compression?: {
    enabled: boolean;
    minSizeBytes?: number; // default: 1024 (1 KB)
    level?: number;        // default: 6 (gzip level 1-9)
  };

  /** Optional: S3 offloading for large payloads */
  s3OffloadConfig?: {
    bucketName: string;             // S3 bucket name (required)
    keyPrefix?: string;             // default: 'langgraph-checkpoints/'
    thresholdBytes?: number;        // default: 358400 (350 KB)
    serverSideEncryption?: string;  // 'AES256' or 'aws:kms'
    sseKmsKeyId?: string;           // KMS key ID or ARN
    clientConfig?: {                // S3 client config
      region?: string;
      endpoint?: string;
      credentials?: unknown;
    };
  };

  /** Optional: AWS SDK DynamoDB client configuration */
  clientConfig?: DynamoDBClientConfig;

  /** Optional: Pre-built DynamoDBDocument client (takes precedence over clientConfig) */
  client?: DynamoDBDocument;

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

The data structure returned by `getTuple()` and `list()`:

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

  /** Optional: Pending writes to be applied (only in getTuple) */
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
  if (error.name === 'CheckpointerValidationError') {
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

// Fine-grained TTL (seconds)
const preciseCheckpointer = new DynamoDBSaver({
  checkpointsTableName: 'checkpoints',
  writesTableName: 'writes',
  ttlSeconds: 86400 * 7, // 7 days in seconds
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
- **TTL**: Max 1825 days (5 years)
- **List Limit**: Max 1000 checkpoints per query
- **Writes Count**: Max 1000 pending writes per checkpoint
- **Batch Size**: Writes are batched in groups of 25 for DynamoDB
- **Delete Safety**: Max 1000 items per delete operation (query iterations capped at 10)

## Performance Tips

1. **Metadata/Payload Split**: List queries read only lightweight metadata items, not heavy blobs
2. **BatchGetItem**: Payload fetching uses batches of 100 keys for efficient bulk reads
3. **ConsistentRead**: Only used on `getTuple()` (not wasted on `list()`)
4. **Enable Compression**: Reduces item sizes by up to 90% for text-heavy checkpoints
5. **S3 Offloading**: Prevents hitting DynamoDB's 400 KB item limit for large states
6. **Use Namespaces**: Organize checkpoints by namespace for efficient querying
7. **Limit List Queries**: Use pagination with `limit` parameter
8. **Clean Up Threads**: Delete completed workflow threads to reduce storage costs
9. **Enable TTL**: Configure appropriate TTL for automatic cleanup
10. **Monitor Costs**: Use DynamoDB on-demand billing for variable workloads

## API Reference

For detailed API documentation, see:

- [DynamoDBSaver Class](../../docs/classes/DynamoDBSaver.md)
- [DynamoDBSaverOptions Interface](../../docs/interfaces/DynamoDBSaverOptions.md)

## Related Documentation

- [DynamoDBStore](../store/store.md) - Memory/knowledge storage
- [DynamoDBChatMessageHistory](../history/history.md) - Chat message history
- [LangGraph Documentation](https://langchain-ai.github.io/langgraphjs/)
