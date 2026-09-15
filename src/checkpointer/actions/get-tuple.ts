import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { assembleTuple } from '../internal/assemble';
import { readConfigurable, readThreadlessConfigurable } from '../internal/configurable';
import { fetchTargetMeta } from '../internal/fetch';
import type { CheckpointerContext } from '../internal/setup';

/**
 * One checkpoint with its metadata and pending writes.
 *
 * Accepts: `config` — `checkpoint_id` names the checkpoint, and its absence
 * asks for the newest in the namespace. A config naming **no thread** is
 * accepted: its other identifiers are still validated, and the answer is
 * "nothing" rather than an error, which is what the reference saver does
 * (`@langchain/langgraph-checkpoint@1.1.5` `dist/memory.js:86-92`: `thread_id`
 * is read optionally while `checkpoint_ns` is asserted either way).
 *
 * Returns: the tuple, or undefined for an unknown thread, an unknown
 * checkpoint, a config naming no thread, or a META row whose PAYLOAD row is not
 * there yet — the window the ordered write leaves open.
 *
 * Throws: ValidationError for a malformed identifier; whatever the reads throw.
 *
 * Guarantees: strongly consistent, so a checkpoint just written is always seen.
 */
export async function getCheckpointTuple(
  context: CheckpointerContext,
  config: RunnableConfig,
): Promise<CheckpointTuple | undefined> {
  if (config.configurable?.thread_id === undefined) {
    readThreadlessConfigurable(config);
    return undefined;
  }
  const { threadId, checkpointNs, checkpointId } = readConfigurable(config);
  const meta = await fetchTargetMeta(context, threadId, checkpointNs, checkpointId, config.signal);
  if (!meta) return undefined;
  return assembleTuple(context, threadId, checkpointNs, meta, {
    signal: config.signal,
    consistent: true,
  });
}
