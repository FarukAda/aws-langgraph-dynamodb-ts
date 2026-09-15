import type { RunnableConfig } from '@langchain/core/runnables';

import type { CheckpointConfigurable } from '../types';
import { validateCheckpointId, validateCheckpointNs, validateThreadId } from './validation';

/** The thread/namespace/checkpoint identifiers extracted from a config. */
export interface ResolvedConfigurable {
  threadId: string;
  checkpointNs: string;
  checkpointId?: string;
}

/**
 * The identifiers of a config that names no thread, validated the same way.
 *
 * Accepts: `config` — its `checkpoint_ns` and `checkpoint_id`, if given.
 *
 * Returns: the resolved identifiers with an empty `threadId`; the caller
 * decides what a missing thread means for its own operation.
 *
 * Throws: ValidationError for a malformed `checkpoint_ns` or `checkpoint_id`.
 * A config without a thread is still checked for the identifiers it *does*
 * give, which is what the reference saver does
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/memory.js:86-92`, where
 * `checkpoint_ns` is asserted whether or not a thread id is present).
 */
export function readThreadlessConfigurable(config: RunnableConfig): ResolvedConfigurable {
  const configurable = (config.configurable ?? {}) as CheckpointConfigurable;
  const checkpointNs = configurable.checkpoint_ns ?? '';
  validateCheckpointNs(checkpointNs);
  const rawId = configurable.checkpoint_id ?? configurable.thread_ts;
  const checkpointId = rawId ? rawId : undefined;
  if (checkpointId !== undefined) validateCheckpointId(checkpointId);
  return { threadId: '', checkpointNs, checkpointId };
}

/**
 * The thread, namespace and checkpoint a config addresses.
 *
 * Accepts: `config.configurable` — `thread_id` is required; `checkpoint_ns`
 * defaults to the root namespace; `checkpoint_id` may also arrive under the
 * legacy `thread_ts` alias, and a falsy value there (`''`, `null`) means "the
 * latest", exactly as the reference's `getCheckpointId` resolves it.
 *
 * Returns: the three identifiers, with `checkpointId` undefined for "latest".
 *
 * Throws: ValidationError naming `thread_id`, `checkpoint_ns` or
 * `checkpoint_id` for a malformed identifier.
 */
export function readConfigurable(config: RunnableConfig): ResolvedConfigurable {
  const configurable = (config.configurable ?? {}) as CheckpointConfigurable;
  validateThreadId(configurable.thread_id);
  const checkpointNs = configurable.checkpoint_ns ?? '';
  validateCheckpointNs(checkpointNs);
  /**
   * `null`, `''` and the legacy `thread_ts` alias resolve the way the reference's
   * `getCheckpointId` does: a falsy id addresses the latest checkpoint rather
   * than failing a config that was built from JSON or ported from another saver.
   */
  const rawId = configurable.checkpoint_id ?? configurable.thread_ts;
  const checkpointId = rawId ? rawId : undefined;
  if (checkpointId !== undefined) validateCheckpointId(checkpointId);
  return { threadId: configurable.thread_id, checkpointNs, checkpointId };
}
