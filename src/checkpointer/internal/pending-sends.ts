import { type Checkpoint, maxChannelVersion, TASKS } from '@langchain/langgraph-checkpoint';

import { fetchPendingWrites, type ReadOptions } from './fetch';
import type { CheckpointerContext } from './setup';

/**
 * Pre-v4 checkpoints kept a task's `Send`s as `__pregel_tasks` pending writes
 * on the parent rather than in the checkpoint itself. Reading such a
 * checkpoint rebuilds `channel_values[TASKS]` from those writes and stamps
 * the channel with the highest version the checkpoint already carries (or
 * the first version when it carries none), exactly as the reference savers
 * do, so a thread written before LangGraph 0.2 still resumes. A v4 checkpoint,
 * or one without a parent, is returned untouched.
 */
export async function migratePendingSends(
  context: CheckpointerContext,
  checkpoint: Checkpoint,
  threadId: string,
  checkpointNs: string,
  parentCheckpointId: string | undefined,
  read: ReadOptions,
): Promise<Checkpoint> {
  if (checkpoint.v >= 4 || parentCheckpointId === undefined) return checkpoint;
  const writes = await fetchPendingWrites(
    context,
    threadId,
    checkpointNs,
    parentCheckpointId,
    read,
  );
  const sends = writes.filter(([, channel]) => channel === TASKS).map(([, , value]) => value);
  const versions = Object.values(checkpoint.channel_versions);
  return {
    ...checkpoint,
    channel_values: { ...checkpoint.channel_values, [TASKS]: sends },
    channel_versions: {
      ...checkpoint.channel_versions,
      [TASKS]: versions.length > 0 ? maxChannelVersion(...versions) : 1,
    },
  };
}
