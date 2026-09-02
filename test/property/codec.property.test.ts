import fc from 'fast-check';

import { type CodecDeps, decodePayload, encodePayload } from '../../src/shared/codec/codec';
import type { CompressionConfig } from '../../src/shared/codec/compression';
import { JSON_SERDE } from '../../src/shared/codec/json-serde';

const KEY_PARTS = ['t', 'ns', 'cp', 'payload'];

async function roundTrip(value: unknown, deps: CodecDeps): Promise<unknown> {
  const descriptor = await encodePayload(value, deps, { keyParts: KEY_PARTS });
  return decodePayload(descriptor, deps, []);
}

/**
 * The codec must be transparent over the serde: its round-trip equals the
 * serde's own JSON round-trip (which normalises e.g. `-0` to `0` — JSON has no
 * negative zero). The codec adds compression/offload, never value semantics.
 */
function serdeOracle(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

describe('codec round-trip identity (property)', () => {
  it('is transparent over the serde with no compression', async () => {
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        const decoded = await roundTrip(value, { serde: JSON_SERDE });
        expect(decoded).toEqual(serdeOracle(value));
      }),
      { numRuns: 300 },
    );
  });

  it('is transparent over the serde with compression forced on', async () => {
    const compression: CompressionConfig = { enabled: true, minSizeBytes: 0, level: 6 };
    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (value) => {
        const decoded = await roundTrip(value, { serde: JSON_SERDE, compression });
        expect(decoded).toEqual(serdeOracle(value));
      }),
      { numRuns: 300 },
    );
  });
});
