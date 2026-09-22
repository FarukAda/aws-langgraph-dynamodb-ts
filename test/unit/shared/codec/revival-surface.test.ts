import { isDeltaSnapshot } from '@langchain/langgraph-checkpoint';
import type { SerializerProtocol } from '@langchain/langgraph-checkpoint';

import { DynamoDBSaver } from '../../../../src/checkpointer/saver';
import { loadPayloadValue } from '../../../../src/shared/codec/codec';
import { ErrorCode } from '../../../../src/shared/errors/error-code';
import { SILENT_LOGGER } from '../../../../src/shared/logging/logger';
import { createStrictDocumentMock } from '../../../shared/helpers/ddb-mock';

/**
 * `SECURITY.md` and the README's *Trust boundary* state, as measured facts,
 * what the checkpointer's default serializer rebuilds out of a stored row.
 * Nothing else in this repository measures them, so both documents were once
 * wrong in the direction that costs most — claiming a narrower boundary than
 * the serializer has — and were corrected only because someone re-ran the
 * measurement by hand.
 *
 * This is that measurement, run against the serializer a saver actually
 * carries. It fails when the upstream revival surface moves, which is exactly
 * when those two documents have to be re-read: a threat model is written
 * against this behaviour, and the behaviour belongs to a dependency this
 * package keeps current.
 */
function defaultSerde(): SerializerProtocol {
  const { client } = createStrictDocumentMock();
  return new DynamoDBSaver({ tableName: 'ckpt', client, logger: SILENT_LOGGER }).serde;
}

const reviveText = async (json: string): Promise<unknown> =>
  loadPayloadValue('json', new TextEncoder().encode(json), { serde: defaultSerde() });

const revive = async (record: unknown): Promise<unknown> => reviveText(JSON.stringify(record));

/** What a revived value reports itself as, without asking `instanceof`. */
const constructorName = (value: unknown): string =>
  value === undefined || value === null
    ? String(value)
    : String(
        (Object.getPrototypeOf(value) as { constructor?: { name?: string } })?.constructor?.name,
      );

const lc1 = (id: unknown[]) => ({ lc: 1, type: 'constructor', id, kwargs: {} });

describe('the record shape that reaches the allow-list', () => {
  it('resolves an allow-listed id and refuses one outside it, naming the serde', async () => {
    expect(
      constructorName(
        await revive({
          lc: 1,
          type: 'constructor',
          id: ['langchain_core', 'messages', 'HumanMessage'],
          kwargs: { content: 'hi' },
        }),
      ),
    ).toBe('HumanMessage');
    for (const id of [
      ['evil', 'Thing'],
      ['node', 'child_process', 'exec'],
      ['langchain_core', 'messages', 'NoSuchMessage'],
    ]) {
      await expect(revive(lc1(id))).rejects.toMatchObject({
        code: ErrorCode.VALIDATION,
        context: { field: 'serde' },
      });
    }
  });

  /**
   * The documents used to call this "a path to an allow-listed class". The
   * name is looked up across everything the resolved namespace exports and
   * then invoked with `new`, so an ordinary function resolves the same way —
   * and `load()` finishes by renaming what it built, which for a function
   * returning a plain object renames the **global `Object`** for the life of
   * the process. The rename is undone here because this process has other
   * tests to run; a reader's process has no such afterwards.
   */
  it('resolves an exported function, and that read renames the global Object', async () => {
    const before = Object.name;
    try {
      const resolved = await revive({
        lc: 1,
        type: 'constructor',
        id: ['langchain_core', 'utils', 'function_calling', 'convertToOpenAITool'],
        kwargs: {},
      });
      expect(resolved).toBeDefined();
      expect(Object.name).toBe('convertToOpenAITool');
      expect({}.constructor.name).toBe('convertToOpenAITool');
    } finally {
      Object.defineProperty(Object, 'name', { value: before, configurable: true });
    }
    expect(Object.name).toBe('Object');
  });

  /** A shape that is not that one is never resolved, whatever its id names. */
  it.each([
    ['an id that is not an array', { lc: 1, type: 'constructor', id: 'evil', kwargs: {} }],
    ['a type that is not "constructor"', { lc: 1, type: 'other', id: ['evil', 'Thing'] }],
    ['an lc that is neither 1 nor 2', { lc: 3, type: 'constructor', id: ['evil', 'Thing'] }],
  ])('returns %s as the plain object it is', async (_name, record) => {
    expect(await revive(record)).toEqual(record);
  });
});

/**
 * The second shape, and the only one whose list of names never consults the
 * allow-list. `SECURITY.md` states that list as exactly five.
 */
describe('the second record shape', () => {
  const lc2 = (id: string, rest: Record<string, unknown>) => ({
    lc: 2,
    type: 'constructor',
    id: [id],
    method: null,
    kwargs: {},
    ...rest,
  });

  it.each([
    ['Set', { args: [[1, 2]] }],
    ['Map', { args: [[['k', 1]]] }],
    ['RegExp', { args: ['ab+c', 'gi'] }],
    ['Error', { args: ['boom'] }],
  ])('rebuilds a %s without consulting the allow-list', async (name, rest) => {
    expect(constructorName(await revive(lc2(name, rest)))).toBe(name);
  });

  it('rebuilds a Uint8Array, the fifth and last name', async () => {
    const revived = await revive({
      lc: 2,
      type: 'constructor',
      id: ['Uint8Array'],
      method: 'from',
      args: [[1, 2, 3]],
      kwargs: {},
    });
    expect(constructorName(revived)).toBe('Uint8Array');
    expect([...(revived as Uint8Array)]).toEqual([1, 2, 3]);
  });

  it.each([['child_process'], ['Function'], ['Object'], ['Proxy']])(
    'leaves an id outside those five — %s — inert, and raises nothing',
    async (name) => {
      const record = lc2(name, { method: 'exec', args: ['x'] });
      expect(await revive(record)).toEqual(record);
    },
  );
});

/**
 * Two further `lc: 2` shapes are not constructor records and hand back no
 * data. The documents claimed every other shape was "returned as inert data",
 * which neither of these is: one erases the key that held it and the other
 * builds a LangGraph value around whatever the row supplied.
 */
describe('the two lc:2 shapes that are not constructor records', () => {
  it('reads {"lc":2,"type":"undefined"} back as undefined, removing the key', async () => {
    expect(await revive({ lc: 2, type: 'undefined' })).toBeUndefined();
    expect(await revive({ keep: 1, drop: { lc: 2, type: 'undefined' } })).toEqual({ keep: 1 });
  });

  it('builds a DeltaSnapshot around whatever the row put in `value`', async () => {
    const revived = await revive({ lc: 2, type: 'delta_snapshot', value: { a: 1 } });
    expect(isDeltaSnapshot(revived)).toBe(true);
    expect((revived as { value: unknown }).value).toEqual({ a: 1 });
  });

  it('leaves a delta_snapshot record carrying no `value` inert', async () => {
    const record = { lc: 2, type: 'delta_snapshot' };
    expect(await revive(record)).toEqual(record);
  });
});

/**
 * The prototype claim, which both documents make in both directions: the
 * revived object's own prototype is replaced, and the process-wide one is not.
 */
describe('a stored __proto__ key', () => {
  it('becomes the revived object prototype and leaves Object.prototype alone', async () => {
    const revived = (await reviveText('{"__proto__":{"polluted":"yes"}}')) as Record<
      string,
      unknown
    >;
    expect(revived.polluted).toBe('yes');
    expect(Object.hasOwn(revived, 'polluted')).toBe(false);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
