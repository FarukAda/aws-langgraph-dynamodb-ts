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
 * Narrow `RunnableConfig.configurable` to the identifiers the saver needs,
 * defaulting the namespace to empty and validating that a thread id is present.
 */
export function readConfigurable(config: RunnableConfig): ResolvedConfigurable {
  const configurable = (config.configurable ?? {}) as CheckpointConfigurable;
  validateThreadId(configurable.thread_id);
  const checkpointNs = configurable.checkpoint_ns ?? '';
  validateCheckpointNs(checkpointNs);
  if (configurable.checkpoint_id !== undefined) {
    validateCheckpointId(configurable.checkpoint_id);
  }
  return {
    threadId: configurable.thread_id,
    checkpointNs,
    checkpointId: configurable.checkpoint_id,
  };
}
