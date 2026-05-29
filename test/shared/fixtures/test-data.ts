/**
 * Deterministic fixture builders (no Math.random — REQ-39 / gap L).
 *
 * Every builder is pure and stable: the same options always produce the same
 * object. Timestamps are derived from FROZEN_NOW_MS so asserted DDB inputs can
 * be pinned to constants (REQ-12 / AC-9).
 */
import { AIMessage, HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { Checkpoint, CheckpointMetadata } from '@langchain/langgraph-checkpoint';

/** Canonical identifiers used across the unit suite. */
export const USER_ID = 'user-123';
export const SESSION_ID = 'session-abc';
export const THREAD_ID = 'thread-xyz';
export const NAMESPACE: readonly string[] = ['ns'];

export interface BaseMessageOptions {
  role?: 'human' | 'ai';
  content?: string;
}

/** A single deterministic BaseMessage. */
export function makeBaseMessage(opts: BaseMessageOptions = {}): BaseMessage {
  const content = opts.content ?? 'hello world';
  return opts.role === 'ai' ? new AIMessage(content) : new HumanMessage(content);
}

/** N deterministic messages, alternating human/ai, stable content per index. */
export function makeMessages(n: number): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push(
      makeBaseMessage({
        role: i % 2 === 0 ? 'human' : 'ai',
        content: `message-${i}`,
      }),
    );
  }
  return out;
}

export interface CheckpointOptions {
  id?: string;
  ts?: string;
  channelValues?: Record<string, unknown>;
}

/** A deterministic Checkpoint object. */
export function makeCheckpoint(opts: CheckpointOptions = {}): Checkpoint {
  return {
    v: 1,
    id: opts.id ?? 'ckpt-1',
    ts: opts.ts ?? '2023-11-14T22:13:20.000Z',
    channel_values: opts.channelValues ?? { messages: [] },
    channel_versions: {},
    versions_seen: {},
    pending_sends: [],
  } as unknown as Checkpoint;
}

export interface CheckpointMetadataOptions {
  source?: CheckpointMetadata['source'];
  step?: number;
}

/** Deterministic CheckpointMetadata. */
export function makeCheckpointMetadata(opts: CheckpointMetadataOptions = {}): CheckpointMetadata {
  return {
    source: opts.source ?? 'input',
    step: opts.step ?? 0,
    parents: {},
  } as CheckpointMetadata;
}

export interface PutOperationOptions {
  namespace?: string[];
  key?: string;
  value?: Record<string, unknown>;
}

/** A store PutOperation tuple ({ namespace, key, value }). */
export function makePutOperation(opts: PutOperationOptions = {}): {
  namespace: string[];
  key: string;
  value: Record<string, unknown>;
} {
  return {
    namespace: opts.namespace ?? [...NAMESPACE],
    key: opts.key ?? 'key1',
    value: opts.value ?? { data: 'value' },
  };
}

export interface RunnableConfigOptions {
  userId?: string;
  threadId?: string;
  checkpointId?: string;
  checkpointNs?: string;
}

/** A RunnableConfig with a configurable block populated deterministically. */
export function makeRunnableConfig(opts: RunnableConfigOptions = {}): RunnableConfig {
  const configurable: Record<string, unknown> = {};
  if (opts.userId !== undefined) configurable.user_id = opts.userId;
  if (opts.threadId !== undefined) configurable.thread_id = opts.threadId;
  if (opts.checkpointId !== undefined) configurable.checkpoint_id = opts.checkpointId;
  configurable.checkpoint_ns = opts.checkpointNs ?? '';
  return { configurable };
}

export interface SessionMetadataOptions {
  sessionId?: string;
  title?: string;
  messageCount?: number;
  updatedAt?: number;
}

/** A SessionMetadata-shaped fixture. */
export function makeSessionMetadata(opts: SessionMetadataOptions = {}): {
  sessionId: string;
  title: string;
  messageCount: number;
  updatedAt: number;
} {
  return {
    sessionId: opts.sessionId ?? SESSION_ID,
    title: opts.title ?? 'Untitled',
    messageCount: opts.messageCount ?? 0,
    updatedAt: opts.updatedAt ?? 1_700_000_000_000,
  };
}
