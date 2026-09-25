import type { RunnableConfig } from '@langchain/core/runnables';
import type { CheckpointTuple } from '@langchain/langgraph-checkpoint';

import { parseConfig, ROOT_NAMESPACE, type ThreadAddress } from '../internal/parse';
import { assembleTuple, fetchTargetMeta } from '../internal/read';
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
 * `config.signal` — cancels the reads; checked before any of them.
 *
 * Returns: the tuple, or undefined for an unknown thread, an unknown
 * checkpoint, a config naming no thread, or a META row whose PAYLOAD row is not
 * there yet — the window the ordered write leaves open.
 *
 * Throws: `VALIDATION`, before any read, naming `config`, `configurable` or
 * `signal` for a config of the wrong shape, or `thread_id`, `checkpoint_ns`,
 * `checkpoint_id` or `thread_ts` for a malformed identifier; whatever the
 * reads throw.
 *
 * Guarantees: strongly consistent, so a checkpoint just written is always seen.
 */
export async function getCheckpointTuple(
  context: CheckpointerContext,
  config: RunnableConfig,
): Promise<CheckpointTuple | undefined> {
  const parsed = parseConfig(config);
  if (parsed.threadId === undefined) return undefined;
  const address: ThreadAddress = {
    threadId: parsed.threadId,
    checkpointNs: parsed.checkpointNs ?? ROOT_NAMESPACE,
    checkpointId: parsed.checkpointId,
  };
  const meta = await fetchTargetMeta(context, address, parsed.signal);
  if (!meta) return undefined;
  return assembleTuple(
    context,
    { threadId: address.threadId, checkpointNs: address.checkpointNs },
    meta,
    {
      signal: parsed.signal,
      consistent: true,
    },
  );
}
