import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  Annotation,
  Command,
  END,
  interrupt,
  MemorySaver,
  Send,
  START,
  StateGraph,
} from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../src/index';
import { createTable, DDB_LOCAL_CONFIG, deleteTable } from '../integration/helpers/ddb-local';

const tableName = 'graph-conformance';
const admin = new DynamoDBClient(DDB_LOCAL_CONFIG);
let saver: DynamoDBSaver;

beforeAll(async () => {
  await createTable(admin, tableName);
  saver = new DynamoDBSaver({ tableName, clientConfig: DDB_LOCAL_CONFIG });
});

afterAll(async () => {
  saver.destroy();
  await deleteTable(admin, tableName);
  admin.destroy();
});

const State = Annotation.Root({
  steps: Annotation<string[]>({ reducer: (left, right) => left.concat(right), default: () => [] }),
  answer: Annotation<string>({ reducer: (_left, right) => right, default: () => '' }),
});

const WorkerInput = Annotation.Root({ item: Annotation<number> });

const thread = (id: string) => ({ configurable: { thread_id: id } });

/** A snapshot reduced to what two checkpointers must agree on. */
interface Digest {
  next: string[];
  step: number | undefined;
  source: string | undefined;
  values: unknown;
}

/** The interrupt payloads an interrupted `invoke` returns beside the state. */
type Interrupted = { __interrupt__?: { value: unknown }[] };

/** A two-node graph that pauses in `ask` until a human resumes it. */
function approvalGraph(checkpointer: BaseCheckpointSaver) {
  return new StateGraph(State)
    .addNode('ask', () => {
      const reply = interrupt<string, string>('name?');
      return { steps: ['ask'], answer: `Hello, ${reply}` };
    })
    .addNode('finish', () => ({ steps: ['finish'] }))
    .addEdge(START, 'ask')
    .addEdge('ask', 'finish')
    .addEdge('finish', END)
    .compile({ checkpointer });
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const checkpointIdOf = (snapshot: {
  config: { configurable?: Record<string, unknown> };
}): unknown => snapshot.config.configurable?.checkpoint_id;

describe('a compiled LangGraph graph over DynamoDBSaver (TEST-01, CKPT-13)', () => {
  it('pauses at interrupt(), exposes it through getState, and resumes with Command', async () => {
    const graph = approvalGraph(saver);
    const config = thread('interrupt-1');
    const paused = (await graph.invoke({ steps: [] }, config)) as Interrupted;
    expect(paused.__interrupt__?.[0]?.value).toBe('name?');
    const state = await graph.getState(config);
    expect(state.next).toEqual(['ask']);
    expect(state.tasks[0]?.interrupts[0]?.value).toBe('name?');
    const resumed = await graph.invoke(new Command({ resume: 'Ada' }), config);
    expect(resumed.answer).toBe('Hello, Ada');
    expect(resumed.steps).toEqual(['ask', 'finish']);
  });

  it('yields the same state history as MemorySaver for the same run', async () => {
    const digests = await Promise.all(
      [saver, new MemorySaver()].map(async (checkpointer, index) => {
        const graph = approvalGraph(checkpointer);
        const config = thread(`parity-${index}`);
        await graph.invoke({ steps: [] }, config);
        await graph.invoke(new Command({ resume: 'Ada' }), config);
        const snapshots = await collect(graph.getStateHistory(config));
        return snapshots.map((snapshot): Digest => ({
          next: snapshot.next,
          step: snapshot.metadata?.step,
          source: snapshot.metadata?.source,
          values: snapshot.values,
        }));
      }),
    );
    expect(digests[0].length).toBeGreaterThanOrEqual(3);
    expect(digests[0]).toEqual(digests[1]);
  });

  it('checkpoints a compiled subgraph under a namespaced checkpoint_ns', async () => {
    const child = new StateGraph(State)
      .addNode('inner', () => ({ steps: ['inner'] }))
      .addEdge(START, 'inner')
      .addEdge('inner', END)
      .compile();
    const parent = new StateGraph(State)
      .addNode('child', child)
      .addNode('after', () => ({ steps: ['after'] }))
      .addEdge(START, 'child')
      .addEdge('child', 'after')
      .addEdge('after', END)
      .compile({ checkpointer: saver });
    const config = thread('subgraph-1');
    const result = await parent.invoke({ steps: [] }, config);
    expect(result.steps).toEqual(['inner', 'after']);
    const namespaces = new Set<string>();
    for await (const tuple of saver.list(config)) {
      namespaces.add(String(tuple.config.configurable?.checkpoint_ns));
    }
    expect([...namespaces]).toContain('');
    const childNamespace = [...namespaces].find((ns) => ns.startsWith('child:'));
    expect(childNamespace).toBeDefined();
    const childHistory = await collect(
      parent.getStateHistory({
        configurable: { thread_id: 'subgraph-1', checkpoint_ns: childNamespace },
      }),
    );
    expect(childHistory.length).toBeGreaterThan(0);
    expect(childHistory[0].values.steps).toEqual(['inner']);
  });

  it('forks with updateState and resumes the fork independently', async () => {
    const graph = approvalGraph(saver);
    const config = thread('fork-1');
    await graph.invoke({ steps: [] }, config);
    await graph.invoke(new Command({ resume: 'Ada' }), config);
    const history = await collect(graph.getStateHistory(config));
    const beforeAsk = history.filter((snapshot) => snapshot.next.includes('ask')).pop();
    expect(beforeAsk).toBeDefined();
    const fork = await graph.updateState(beforeAsk!.config, { steps: ['forked'] });
    const paused = (await graph.invoke(null, fork)) as Interrupted;
    expect(paused.__interrupt__?.[0]?.value).toBe('name?');
    const done = await graph.invoke(new Command({ resume: 'Bob' }), fork);
    expect(done.answer).toBe('Hello, Bob');
    expect(done.steps).toEqual(['forked', 'ask', 'finish']);
    /** The fork is the thread's newest checkpoint now; the pre-fork run is still readable at its own checkpoint. */
    const original = await graph.getState(history[0].config);
    expect(original.values.answer).toBe('Hello, Ada');
  });

  it('windows the history with limit, before and filter', async () => {
    const graph = approvalGraph(saver);
    const config = thread('window-1');
    await graph.invoke({ steps: [] }, config);
    await graph.invoke(new Command({ resume: 'Ada' }), config);
    const all = await collect(graph.getStateHistory(config));
    expect(all.length).toBeGreaterThanOrEqual(3);
    const limited = await collect(graph.getStateHistory(config, { limit: 2 }));
    expect(limited.map(checkpointIdOf)).toEqual(all.slice(0, 2).map(checkpointIdOf));
    const before = await collect(graph.getStateHistory(config, { before: all[0].config }));
    expect(before.map(checkpointIdOf)).toEqual(all.slice(1).map(checkpointIdOf));
    const inputs = await collect(graph.getStateHistory(config, { filter: { source: 'input' } }));
    expect(inputs.map((snapshot) => snapshot.metadata?.source)).toEqual(['input']);
  });

  it('resumes a crashed run, re-running the failed task against its stored writes', async () => {
    let attempts = 0;
    const graph = new StateGraph(State)
      .addNode('flaky', () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient');
        return { steps: ['flaky'] };
      })
      .addEdge(START, 'flaky')
      .addEdge('flaky', END)
      .compile({ checkpointer: saver });
    const config = thread('crash-1');
    await expect(graph.invoke({ steps: [] }, config)).rejects.toThrow('transient');
    const failed = await graph.getState(config);
    expect(failed.next).toEqual(['flaky']);
    const result = await graph.invoke(null, config);
    expect(result.steps).toEqual(['flaky']);
    expect(attempts).toBe(2);
    const done = await graph.getState(config);
    expect(done.next).toEqual([]);
    expect(done.values.steps).toEqual(['flaky']);
  });

  it('aggregates a Send fan-out of thirty branches', async () => {
    const FAN_OUT = 30;
    const graph = new StateGraph(State)
      .addNode('fan', () => ({}))
      .addNode('worker', (input) => ({ steps: [`w${input.item}`] }), { input: WorkerInput })
      .addEdge(START, 'fan')
      .addConditionalEdges('fan', () =>
        Array.from({ length: FAN_OUT }, (_unused, item) => new Send('worker', { item })),
      )
      .addEdge('worker', END)
      .compile({ checkpointer: saver });
    const result = await graph.invoke({ steps: [] }, thread('fanout-1'));
    expect([...result.steps].sort()).toEqual(
      Array.from({ length: FAN_OUT }, (_unused, item) => `w${item}`).sort(),
    );
  });
});
