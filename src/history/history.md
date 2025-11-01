# DynamoDBChatMessageHistory - Chat Message Storage

The `DynamoDBChatMessageHistory` provides persistent storage for chat conversation history with automatic session management and title generation. It enables chatbots and conversational AI applications to maintain context across multiple interactions.

## Overview

The history module stores chat messages organized by user ID and session ID, maintaining chronological message order. It automatically generates human-readable session titles from the first message and tracks session metadata for efficient session management.

### Key Features

- 💬 **Message Persistence**: Store and retrieve chat conversations
- 👤 **User Isolation**: Separate conversations by user ID
- 🗂️ **Session Management**: Organize messages into distinct conversations
- 📝 **Auto Title Generation**: Automatic session titles from first message
- 📊 **Session Metadata**: Track creation time, update time, and message count
- ⏱️ **TTL Support**: Automatic session expiration
- 🔁 **Retry Logic**: Built-in retry for transient DynamoDB errors
- 🎯 **Type Safe**: Full TypeScript support with LangChain message types

## Installation

```bash
npm install @farukada/aws-langgraph-dynamodb-ts @langchain/core
```

## Table Schema

### Chat History Table

| Attribute | Type | Key | Description |
|-----------|------|-----|-------------|
| `user_id` | String | Partition Key | User identifier for data isolation |
| `session_id` | String | Sort Key | Unique session identifier |
| `title` | String | - | Human-readable session title |
| `messages` | List | - | Array of serialized BaseMessage objects |
| `message_count` | Number | - | Count of messages in the session |
| `created_at` | Number | - | Timestamp (milliseconds since epoch) |
| `updated_at` | Number | - | Timestamp (milliseconds since epoch) |
| `ttl` | Number | - | Optional expiration timestamp (Unix epoch) |

### Message Structure

Each message in the `messages` array contains:

```typescript
{
  type: string;           // Message type: 'human', 'ai', 'system', 'function', etc.
  data: {
    content: string;      // Message content
    additional_kwargs: any; // Optional metadata
    response_metadata: any; // Optional response data
    name?: string;        // Optional sender name
    id?: string;          // Optional message ID
  };
}
```

## Basic Usage

### Creating a Chat History Instance

```typescript
import { DynamoDBChatMessageHistory } from '@farukada/aws-langgraph-dynamodb-ts';

const history = new DynamoDBChatMessageHistory({
  tableName: 'langgraph-chat-history',
  ttlDays: 30, // Optional: Auto-delete after 30 days
  clientConfig: {
    region: 'us-east-1',
    // ... other AWS SDK config
  },
});
```

### Adding Messages

```typescript
import { HumanMessage, AIMessage } from '@langchain/core/messages';

// Add a single message with custom title
await history.addMessage(
  'user-123',
  'session-456',
  new HumanMessage('Hello, how are you?'),
  'Greeting Conversation' // Optional custom title
);

// Add a response
await history.addMessage(
  'user-123',
  'session-456',
  new AIMessage('I am doing well, thank you! How can I help you today?')
);

// Add multiple messages at once (more efficient)
await history.addMessages(
  'user-123',
  'session-789',
  [
    new HumanMessage('What is the weather like?'),
    new AIMessage('I can help you check the weather. What location?'),
    new HumanMessage('New York'),
    new AIMessage('The weather in New York is sunny, 72°F.'),
  ],
  'Weather Query' // Optional custom title
);
```

### Retrieving Messages

```typescript
// Get all messages for a session
const messages = await history.getMessages('user-123', 'session-456');

messages.forEach(message => {
  console.log(`${message._getType()}: ${message.content}`);
});

// Output:
// human: Hello, how are you?
// ai: I am doing well, thank you! How can I help you today?
```

### Listing Sessions

```typescript
// List all sessions for a user
const sessions = await history.listSessions('user-123');

sessions.forEach(session => {
  console.log(`${session.title} - ${session.messageCount} messages`);
  console.log(`  Created: ${new Date(session.createdAt).toISOString()}`);
  console.log(`  Updated: ${new Date(session.updatedAt).toISOString()}`);
});

// List with limit
const recentSessions = await history.listSessions('user-123', 10);
```

### Clearing Sessions

```typescript
// Clear all messages in a session
await history.clear('user-123', 'session-456');
```

## Advanced Usage

### Automatic Title Generation

When adding messages to a new session without specifying a title, the system automatically generates one from the first message:

```typescript
// First message creates session with auto-generated title
await history.addMessage(
  'user-123',
  'new-session',
  new HumanMessage('How do I reset my password?')
);
// Auto-generated title: "How do I reset my p..." (truncated to 50 chars)

// Subsequent messages update the session
await history.addMessage(
  'user-123',
  'new-session',
  new AIMessage('I can help you reset your password...')
);
```

### Session Title Strategies

```typescript
// ✅ Good - Descriptive titles
await history.addMessages(userId, sessionId, messages, 'Password Reset Request');
await history.addMessages(userId, sessionId, messages, 'Product Inquiry - Widget X');
await history.addMessages(userId, sessionId, messages, 'Troubleshooting: Login Error');

// ✅ Good - Let system auto-generate from content
await history.addMessages(userId, sessionId, messages);

// ❌ Bad - Generic titles
await history.addMessages(userId, sessionId, messages, 'Conversation');
await history.addMessages(userId, sessionId, messages, 'Chat');
```

### Using with LangChain Chat Models

```typescript
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

const chat = new ChatOpenAI();
const userId = 'user-123';
const sessionId = 'chat-session-456';

// Load conversation history
const previousMessages = await history.getMessages(userId, sessionId);

// Add new user message
const userMessage = new HumanMessage('What did we discuss about pricing?');
await history.addMessage(userId, sessionId, userMessage);

// Get AI response with full context
const allMessages = [...previousMessages, userMessage];
const response = await chat.invoke(allMessages);

// Save AI response
await history.addMessage(userId, sessionId, new AIMessage(response.content));
```

### Using with LangGraph Workflows

```typescript
import { StateGraph } from '@langchain/langgraph';
import { HumanMessage, AIMessage, BaseMessage } from '@langchain/core/messages';

interface ChatState {
  messages: BaseMessage[];
  userId: string;
  sessionId: string;
}

const workflow = new StateGraph<ChatState>({
  channels: {
    messages: { value: (x, y) => x.concat(y), default: () => [] },
    userId: { value: (x, y) => y ?? x, default: () => '' },
    sessionId: { value: (x, y) => y ?? x, default: () => '' },
  },
})
  .addNode('loadHistory', async (state) => {
    // Load conversation history
    const messages = await history.getMessages(state.userId, state.sessionId);
    return { messages };
  })
  .addNode('processMessage', async (state) => {
    // Process with chat model
    const response = await chat.invoke(state.messages);
    return { messages: [new AIMessage(response.content)] };
  })
  .addNode('saveHistory', async (state) => {
    // Save all new messages
    const newMessages = state.messages.slice(-2); // Last user + AI message
    await history.addMessages(state.userId, state.sessionId, newMessages);
    return {};
  })
  .addEdge('__start__', 'loadHistory')
  .addEdge('loadHistory', 'processMessage')
  .addEdge('processMessage', 'saveHistory')
  .addEdge('saveHistory', '__end__');

const app = workflow.compile();

// Execute workflow
const result = await app.invoke({
  messages: [new HumanMessage('Hello!')],
  userId: 'user-123',
  sessionId: 'chat-456',
});
```

### Multi-turn Conversations

```typescript
async function chatWithHistory(
  userId: string,
  sessionId: string,
  userInput: string,
  title?: string
): Promise<string> {
  // Get conversation history
  const previousMessages = await history.getMessages(userId, sessionId);

  // Add new user message
  const userMessage = new HumanMessage(userInput);
  await history.addMessage(userId, sessionId, userMessage, title);

  // Get AI response with context
  const messages = [...previousMessages, userMessage];
  const response = await chat.invoke(messages);

  // Save AI response
  await history.addMessage(userId, sessionId, new AIMessage(response.content));

  return response.content;
}

// Example usage
const response1 = await chatWithHistory(
  'user-123',
  'support-001',
  'I need help with my order',
  'Order Support'
);

const response2 = await chatWithHistory(
  'user-123',
  'support-001',
  'It was supposed to arrive yesterday'
  // No title - session already exists
);
```

### Session Management UI

```typescript
// Build a session list for user interface
async function getUserChatSessions(userId: string) {
  const sessions = await history.listSessions(userId, 20);

  return sessions.map(session => ({
    id: session.sessionId,
    title: session.title,
    messageCount: session.messageCount,
    lastActivity: new Date(session.updatedAt).toLocaleString(),
    createdAt: new Date(session.createdAt).toLocaleString(),
  }));
}

// Delete old or unwanted sessions
async function cleanupOldSessions(userId: string, daysOld: number) {
  const sessions = await history.listSessions(userId);
  const cutoffTime = Date.now() - (daysOld * 24 * 60 * 60 * 1000);

  for (const session of sessions) {
    if (session.updatedAt < cutoffTime) {
      await history.clear(userId, session.sessionId);
      console.log(`Deleted old session: ${session.title}`);
    }
  }
}
```

## Configuration Options

### DynamoDBChatMessageHistoryOptions

```typescript
interface DynamoDBChatMessageHistoryOptions {
  /** Name of the DynamoDB table for chat history */
  tableName: string;

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

### SessionMetadata

Returned by `listSessions()`:

```typescript
interface SessionMetadata {
  /** Session identifier */
  sessionId: string;

  /** Session title */
  title: string;

  /** Timestamp when session was created (milliseconds) */
  createdAt: number;

  /** Timestamp when session was last updated (milliseconds) */
  updatedAt: number;

  /** Number of messages in the session */
  messageCount: number;
}
```

## Message Types

LangChain provides various message types for different conversation participants:

```typescript
import {
  HumanMessage,
  AIMessage,
  SystemMessage,
  FunctionMessage,
  ToolMessage,
} from '@langchain/core/messages';

// User messages
new HumanMessage('Hello!');
new HumanMessage({ content: 'Hello!', name: 'John' });

// AI assistant messages
new AIMessage('Hi there!');
new AIMessage({
  content: 'The result is 42',
  additional_kwargs: { confidence: 0.95 },
});

// System messages (instructions)
new SystemMessage('You are a helpful assistant.');

// Function/Tool messages
new FunctionMessage({
  content: JSON.stringify({ result: 'success' }),
  name: 'get_weather',
});

new ToolMessage({
  content: 'Weather data retrieved',
  tool_call_id: 'call-123',
});
```

## Best Practices

### Session ID Organization

```typescript
// ✅ Good - Unique, descriptive IDs
const sessionId = `chat-${Date.now()}-${userId}`;
const sessionId = `support-${ticketId}`;
const sessionId = `${userId}-${conversationType}-${timestamp}`;

// ❌ Bad - Generic or collision-prone
const sessionId = 'session1';
const sessionId = userId; // One session per user only
```

### User ID Management

```typescript
// ✅ Good - Consistent user identification
const userId = user.id; // From authenticated user
const userId = `auth0|${auth0Id}`;
const userId = `customer-${customerId}`;

// ❌ Bad - Mixing identifier types
const userId = user.email; // Email might change
const userId = req.ip; // IP addresses change
```

### Error Handling

```typescript
import { DynamoDBChatMessageHistory } from '@farukada/aws-langgraph-dynamodb-ts';

try {
  const messages = await history.getMessages(userId, sessionId);
} catch (error) {
  if (error.message.includes('User ID cannot be empty')) {
    console.error('Invalid user ID provided');
  } else if (error.message.includes('Session ID cannot be empty')) {
    console.error('Invalid session ID provided');
  } else if (error.name === 'ValidationError') {
    console.error('Validation failed:', error.message);
  } else if (error.name === 'ResourceNotFoundException') {
    console.error('DynamoDB table not found');
  } else {
    console.error('Failed to retrieve messages:', error);
  }
}
```

### Performance Optimization

```typescript
// ✅ Good - Use addMessages for multiple messages
await history.addMessages(userId, sessionId, [
  new HumanMessage('Message 1'),
  new AIMessage('Response 1'),
  new HumanMessage('Message 2'),
  new AIMessage('Response 2'),
]);

// ❌ Bad - Multiple individual calls
await history.addMessage(userId, sessionId, new HumanMessage('Message 1'));
await history.addMessage(userId, sessionId, new AIMessage('Response 1'));
await history.addMessage(userId, sessionId, new HumanMessage('Message 2'));
await history.addMessage(userId, sessionId, new AIMessage('Response 2'));

// ✅ Good - Limit session list queries
const recentSessions = await history.listSessions(userId, 10);

// ❌ Bad - Loading all sessions without limit
const allSessions = await history.listSessions(userId);
```

### Message Content Guidelines

```typescript
// ✅ Good - Clear, structured content
new HumanMessage('What is the status of order #12345?');
new AIMessage('Order #12345 is currently in transit, expected delivery: 2024-01-20');

// ✅ Good - Include context in messages
new HumanMessage({
  content: 'Yes, please proceed',
  additional_kwargs: {
    context: 'confirming order cancellation',
    orderId: '12345',
  },
});

// ❌ Bad - Ambiguous references
new HumanMessage('Yes'); // Yes to what?
new AIMessage('Done'); // What was done?
```

### TTL Strategy

```typescript
// Short-lived support chats
const supportHistory = new DynamoDBChatMessageHistory({
  tableName: 'support-chats',
  ttlDays: 7, // Clean up after resolution
});

// Long-term customer conversations
const customerHistory = new DynamoDBChatMessageHistory({
  tableName: 'customer-chats',
  ttlDays: 365, // Keep for a year
});

// Permanent chat archives
const archiveHistory = new DynamoDBChatMessageHistory({
  tableName: 'chat-archives',
  // ttlDays omitted - no expiration
});
```

## Limitations

- **User ID**: Max 256 characters, cannot be empty, cannot contain control characters
- **Session ID**: Max 256 characters, cannot be empty, cannot contain control characters
- **Message Content**: Max 400 KB total per session (DynamoDB item size limit)
- **Message Array**: Recommended max 100-200 messages per session for performance
- **Session Title**: Max 200 characters, auto-truncated if generated from long messages
- **List Sessions**: Returns all sessions for a user (use limit parameter for pagination)
- **Timestamps**: Stored in milliseconds (JavaScript Date.now() format)

## Performance Tips

1. **Use addMessages**: Batch multiple messages in one call
2. **Limit Session Queries**: Use the limit parameter when listing sessions
3. **Session Cleanup**: Regularly delete old or inactive sessions
4. **Message Limit**: Keep sessions under 100-200 messages, create new sessions for long conversations
5. **TTL Configuration**: Set appropriate TTL to automatically clean up old sessions
6. **Monitor Costs**: Use DynamoDB on-demand billing for variable workloads

## API Reference

For detailed API documentation, see:

- [DynamoDBChatMessageHistory Class](./classes/DynamoDBChatMessageHistory.md)
- [DynamoDBChatMessageHistoryOptions Interface](./interfaces/DynamoDBChatMessageHistoryOptions.md)
- [SessionMetadata Interface](./interfaces/SessionMetadata.md)

## Related Documentation

- [DynamoDBSaver](./checkpointer.md) - Checkpoint storage for workflows
- [DynamoDBStore](./store.md) - Memory/knowledge storage
- [LangChain Messages Documentation](https://js.langchain.com/docs/modules/model_io/messages/)
