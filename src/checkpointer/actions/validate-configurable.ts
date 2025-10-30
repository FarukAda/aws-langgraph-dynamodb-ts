import { ValidatedConfigurable } from '../types';
import {
  validateThreadId,
  validateCheckpointId,
  validateCheckpointNs,
  CheckpointerValidationError,
} from '../utils';

/**
 * Validate and extract configurable parameters
 *
 * @param configurable - Configurable object from RunnableConfig
 * @returns Validated configurable parameters
 * @throws CheckpointerValidationError if validation fails
 */
export const validateConfigurable = (
  configurable: Record<string, unknown> | undefined,
): ValidatedConfigurable => {
  if (!configurable) {
    throw new CheckpointerValidationError('Missing configurable');
  }

  const { thread_id, checkpoint_ns, checkpoint_id } = configurable;

  // Validate thread_id (required)
  if (typeof thread_id !== 'string') {
    throw new CheckpointerValidationError('thread_id must be a string');
  }
  validateThreadId(thread_id);

  // Validate checkpoint_ns (optional)
  if (checkpoint_ns !== undefined && typeof checkpoint_ns !== 'string') {
    throw new CheckpointerValidationError('checkpoint_ns must be a string');
  }
  validateCheckpointNs(checkpoint_ns as string | undefined);

  // Validate checkpoint_id (optional)
  if (checkpoint_id !== undefined && typeof checkpoint_id !== 'string') {
    throw new CheckpointerValidationError('checkpoint_id must be a string');
  }
  validateCheckpointId(checkpoint_id as string | undefined, false);

  return {
    thread_id,
    checkpoint_ns: (checkpoint_ns as string) ?? '',
    checkpoint_id: checkpoint_id as string | undefined,
  };
};
