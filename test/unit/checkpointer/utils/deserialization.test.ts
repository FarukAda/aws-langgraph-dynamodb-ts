/**
 * Unit tests for src/checkpointer/utils/deserialization.ts.
 *
 * Plan rows:
 *   AC-8  — documented throw branches: (1) checkpoint references an S3 key but no
 *           offloader is configured; (2) metadata references an S3 key but no
 *           offloader is configured; (3) checkpoint blob fails to deserialize;
 *           (4) metadata blob fails to deserialize. Each asserts the exact
 *           message.
 *   AC-15 — round-trip property table: a checkpoint/metadata pair serialized by a
 *           SerializerProtocol and read back through deserializeCheckpointTuple
 *           deep-equals the originals for empty / unicode / deeply-nested /
 *           large-binary inputs.
 *
 * REQ-11 / REQ-19 / AC-8 / AC-15.
 *
 * Pinned from src/checkpointer/utils/deserialization.ts:
 *   - The only export is the async function
 *     deserializeCheckpointTuple(item, checkpointData, serde, compressor?, s3Offloader?).
 *     There is no encodePayload/decodePayload codec pair; the "codec" under test
 *     is the SerializerProtocol round-trip plumbed through this function.
 *   - It downloads from S3 first for checkpoint (s3_checkpoint_key) then metadata
 *     (s3_metadata_key); a set key with no offloader throws an exact message.
 *   - Deserialization failures are re-thrown as
 *     'Failed to deserialize <checkpoint|metadata> for thread_id=<id>, checkpoint_id=<id>, type=<type>: <cause>'.
 *   - The returned tuple's `config.configurable` carries thread_id / checkpoint_ns
 *     / checkpoint_id, and `checkpoint` / `metadata` are the deserialized values.
 */
import type { CheckpointMetadata, SerializerProtocol } from '@langchain/langgraph-checkpoint';

import type { CheckpointItem } from '../../../../src/checkpointer/types';
import { deserializeCheckpointTuple } from '../../../../src/checkpointer/utils/deserialization';

const THREAD_ID = 'thread-xyz';
const CHECKPOINT_NS = '';
const CHECKPOINT_ID = 'ckpt-1';

/**
 * Deterministic test SerializerProtocol that genuinely round-trips JSON values,
 * including binary, via base64-tagged sentinels so Uint8Array survives. This is
 * the codec whose fidelity AC-15 asserts; the function under test only plumbs it.
 */
function makeJsonSerde(): SerializerProtocol {
  const BIN_TAG = '__u8__';
  return {
    async dumpsTyped(data: unknown): Promise<[string, Uint8Array]> {
      const json = JSON.stringify(data, (_k, v) => {
        if (Object.prototype.toString.call(v) === '[object Uint8Array]') {
          return { [BIN_TAG]: Buffer.from(v as Uint8Array).toString('base64') };
        }
        return v;
      });
      return ['json', new TextEncoder().encode(json)];
    },
    async loadsTyped(_type: string, bytes: Uint8Array | string): Promise<unknown> {
      const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
      return JSON.parse(text, (_k, v) => {
        if (
          v &&
          typeof v === 'object' &&
          typeof (v as Record<string, unknown>)[BIN_TAG] === 'string'
        ) {
          return new Uint8Array(Buffer.from((v as Record<string, string>)[BIN_TAG], 'base64'));
        }
        return v;
      });
    },
  };
}

/** A serde whose loadsTyped always rejects, to drive the deserialize-failure branches. */
function makeFailingSerde(message: string): SerializerProtocol {
  return {
    async dumpsTyped(): Promise<[string, Uint8Array]> {
      return ['json', new Uint8Array()];
    },
    async loadsTyped(): Promise<unknown> {
      throw new Error(message);
    },
  };
}

interface RoundTripCase {
  readonly name: string;
  readonly checkpointValue: Record<string, unknown>;
  readonly metadataValue: CheckpointMetadata;
}

function buildRoundTripCases(): RoundTripCase[] {
  let nested: Record<string, unknown> = { leaf: 'end' };
  for (let i = 0; i < 40; i += 1) {
    nested = { level: i, child: nested };
  }
  const largeBinary = new Uint8Array(256 * 1024);
  for (let i = 0; i < largeBinary.length; i += 1) {
    largeBinary[i] = i % 256;
  }

  const meta = (extra: number): CheckpointMetadata =>
    ({ source: 'input', step: extra, parents: {} }) as CheckpointMetadata;

  return [
    { name: 'empty object', checkpointValue: {}, metadataValue: meta(0) },
    {
      name: 'unicode content',
      checkpointValue: { text: 'こんにちは 🌍 — naïve café ✓ \u{1F600}' },
      metadataValue: meta(1),
    },
    { name: 'deeply nested', checkpointValue: nested, metadataValue: meta(2) },
    { name: 'large binary', checkpointValue: { blob: largeBinary }, metadataValue: meta(3) },
  ];
}

async function buildItem(
  serde: SerializerProtocol,
  checkpointValue: unknown,
  metadataValue: unknown,
): Promise<{ item: CheckpointItem; checkpointData: Uint8Array }> {
  const [type, checkpointData] = await serde.dumpsTyped(checkpointValue);
  const [, metadataBytes] = await serde.dumpsTyped(metadataValue);
  const item: CheckpointItem = {
    thread_id: THREAD_ID,
    checkpoint_ns: CHECKPOINT_NS,
    checkpoint_id: CHECKPOINT_ID,
    type,
    metadata: metadataBytes,
  };
  return { item, checkpointData };
}

describe('deserializeCheckpointTuple round-trip property table', () => {
  it.each(buildRoundTripCases())(
    'reads back the original checkpoint and metadata for $name',
    async ({ checkpointValue, metadataValue }) => {
      const serde = makeJsonSerde();
      const { item, checkpointData } = await buildItem(serde, checkpointValue, metadataValue);

      const tuple = await deserializeCheckpointTuple(item, checkpointData, serde);

      expect(tuple.checkpoint).toEqual(checkpointValue);
      expect(tuple.metadata).toEqual(metadataValue);
      expect(tuple.config.configurable).toEqual({
        thread_id: THREAD_ID,
        checkpoint_ns: CHECKPOINT_NS,
        checkpoint_id: CHECKPOINT_ID,
      });
    },
  ); // AC-15
});

describe('deserializeCheckpointTuple documented throw branches', () => {
  it('throws naming the S3 key when checkpoint is offloaded but no offloader is configured', async () => {
    const serde = makeJsonSerde();
    const [, metadataBytes] = await serde.dumpsTyped({ source: 'input', step: 0, parents: {} });
    const item: CheckpointItem = {
      thread_id: THREAD_ID,
      checkpoint_ns: CHECKPOINT_NS,
      checkpoint_id: CHECKPOINT_ID,
      type: 'json',
      metadata: metadataBytes,
      s3_checkpoint_key: 'ckpt/key-abc',
    };
    await expect(deserializeCheckpointTuple(item, new Uint8Array(), serde)).rejects.toThrow(
      "Checkpoint references S3 key 'ckpt/key-abc' but no S3 offloader is configured. " +
        'Pass s3OffloadConfig when constructing DynamoDBSaver to read offloaded checkpoints.',
    );
  }); // AC-8

  it('throws naming the S3 key when metadata is offloaded but no offloader is configured', async () => {
    const serde = makeJsonSerde();
    const [type, checkpointData] = await serde.dumpsTyped({ ok: true });
    const item: CheckpointItem = {
      thread_id: THREAD_ID,
      checkpoint_ns: CHECKPOINT_NS,
      checkpoint_id: CHECKPOINT_ID,
      type,
      metadata: new Uint8Array(),
      s3_metadata_key: 'meta/key-def',
    };
    await expect(deserializeCheckpointTuple(item, checkpointData, serde)).rejects.toThrow(
      "Checkpoint metadata references S3 key 'meta/key-def' but no S3 offloader is configured. " +
        'Pass s3OffloadConfig when constructing DynamoDBSaver to read offloaded metadata.',
    );
  }); // AC-8

  it('re-throws a checkpoint deserialize failure with thread/checkpoint context', async () => {
    const serde = makeFailingSerde('unexpected token');
    const item: CheckpointItem = {
      thread_id: THREAD_ID,
      checkpoint_ns: CHECKPOINT_NS,
      checkpoint_id: CHECKPOINT_ID,
      type: 'json',
      metadata: new Uint8Array(),
    };
    await expect(deserializeCheckpointTuple(item, new Uint8Array(), serde)).rejects.toThrow(
      `Failed to deserialize checkpoint for thread_id=${THREAD_ID}, checkpoint_id=${CHECKPOINT_ID}, type=json: unexpected token`,
    );
  }); // AC-8

  it('re-throws a metadata deserialize failure with thread/checkpoint context', async () => {
    // Checkpoint deserializes fine (valid JSON bytes), metadata bytes are invalid
    // JSON so only the metadata loadsTyped fails.
    const realSerde = makeJsonSerde();
    const [type, checkpointData] = await realSerde.dumpsTyped({ ok: true });
    const failOnMetadata: SerializerProtocol = {
      dumpsTyped: realSerde.dumpsTyped,
      async loadsTyped(t: string, bytes: Uint8Array | string): Promise<unknown> {
        const text = typeof bytes === 'string' ? bytes : new TextDecoder().decode(bytes);
        if (text === 'NOT_JSON') {
          throw new Error('bad metadata');
        }
        return realSerde.loadsTyped(t, bytes);
      },
    };
    const item: CheckpointItem = {
      thread_id: THREAD_ID,
      checkpoint_ns: CHECKPOINT_NS,
      checkpoint_id: CHECKPOINT_ID,
      type,
      metadata: new TextEncoder().encode('NOT_JSON'),
    };
    await expect(deserializeCheckpointTuple(item, checkpointData, failOnMetadata)).rejects.toThrow(
      `Failed to deserialize metadata for thread_id=${THREAD_ID}, checkpoint_id=${CHECKPOINT_ID}, type=json: bad metadata`,
    );
  }); // AC-8

  it('stringifies a non-object thrown value into the failure message (kills `true` message-guard mutant)', () => {
    // loadsTyped throws a bare string (no `.message`). Source guards with
    // `err && typeof err === 'object' && 'message' in err`; for a string this is
    // false so it uses String(err) === the raw string. Mutating the guard to
    // `true` would read `.message` off the string -> 'undefined'.
    const throwsString: SerializerProtocol = {
      async dumpsTyped(): Promise<[string, Uint8Array]> {
        return ['json', new Uint8Array()];
      },
      async loadsTyped(): Promise<unknown> {
        throw 'raw-string-failure';
      },
    };
    const item: CheckpointItem = {
      thread_id: THREAD_ID,
      checkpoint_ns: CHECKPOINT_NS,
      checkpoint_id: CHECKPOINT_ID,
      type: 'json',
      metadata: new Uint8Array(),
    };
    return expect(deserializeCheckpointTuple(item, new Uint8Array(), throwsString)).rejects.toThrow(
      `Failed to deserialize checkpoint for thread_id=${THREAD_ID}, checkpoint_id=${CHECKPOINT_ID}, type=json: raw-string-failure`,
    );
  }); // AC-8

  it('attaches the original error as the thrown error cause (kills `{ cause: err }` -> `{}` mutant)', async () => {
    const original = new Error('inner boom');
    const failing: SerializerProtocol = {
      async dumpsTyped(): Promise<[string, Uint8Array]> {
        return ['json', new Uint8Array()];
      },
      async loadsTyped(): Promise<unknown> {
        throw original;
      },
    };
    const item: CheckpointItem = {
      thread_id: THREAD_ID,
      checkpoint_ns: CHECKPOINT_NS,
      checkpoint_id: CHECKPOINT_ID,
      type: 'json',
      metadata: new Uint8Array(),
    };
    let caught: unknown;
    try {
      await deserializeCheckpointTuple(item, new Uint8Array(), failing);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error & { cause?: unknown }).cause).toBe(original);
  }); // AC-8
});

describe('deserializeCheckpointTuple parentConfig branch', () => {
  it('populates parentConfig with the parent_checkpoint_id when present (kills NoCoverage parentConfig object)', async () => {
    const serde = makeJsonSerde();
    const { item, checkpointData } = await buildItem(
      serde,
      { ok: true },
      { source: 'input', step: 0, parents: {} },
    );
    const PARENT_ID = 'ckpt-parent-0';
    const itemWithParent: CheckpointItem = { ...item, parent_checkpoint_id: PARENT_ID };

    const tuple = await deserializeCheckpointTuple(itemWithParent, checkpointData, serde);

    expect(tuple.parentConfig).toEqual({
      configurable: {
        thread_id: THREAD_ID,
        checkpoint_ns: CHECKPOINT_NS,
        checkpoint_id: PARENT_ID,
      },
    });
  }); // AC-8

  it('leaves parentConfig undefined when there is no parent_checkpoint_id', async () => {
    const serde = makeJsonSerde();
    const { item, checkpointData } = await buildItem(
      serde,
      { ok: true },
      { source: 'input', step: 0, parents: {} },
    );
    const tuple = await deserializeCheckpointTuple(item, checkpointData, serde);
    expect(tuple.parentConfig).toBeUndefined();
  }); // AC-8
});
