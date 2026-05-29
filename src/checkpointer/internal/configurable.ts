import type { RunnableConfig } from '@langchain/core/runnables';

import { validateNonEmptyString } from '../../shared/validation/primitives';
import type { CheckpointConfigurable } from '../types';

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
  validateNonEmptyString(configurable.thread_id, 'thread_id');
  return {
    threadId: configurable.thread_id,
    checkpointNs: configurable.checkpoint_ns ?? '',
    checkpointId: configurable.checkpoint_id,
  };
}
