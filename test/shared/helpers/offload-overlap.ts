/** The offloader surface the codec and cleanup paths call, backed by memory. */
export interface OverlapOffloader {
  shouldOffload: (data: Uint8Array) => boolean;
  buildKey: (parts: readonly string[]) => string;
  upload: (key: string, data: Uint8Array) => Promise<string>;
  download: (key: string) => Promise<Uint8Array>;
  deleteBatch: (keys: string[]) => Promise<string[]>;
  ownsKey: (key: string, scope: readonly string[]) => boolean;
  assertOwnedKey: (key: string, scope: readonly string[]) => void;
}

/**
 * An in-memory offloader whose downloads yield once to the event loop and
 * record how many were in flight at the same time, so a test can prove that
 * decodes overlap (strictly sequential code measures exactly 1) without any
 * timing assumptions.
 */
export function overlapOffloader(): { offloader: OverlapOffloader; maxInFlight: () => number } {
  const objects = new Map<string, Uint8Array>();
  let inFlight = 0;
  let max = 0;
  const offloader: OverlapOffloader = {
    shouldOffload: () => true,
    buildKey: (parts) => parts.join('/'),
    upload: async (key, data) => {
      objects.set(key, data);
      return key;
    },
    download: async (key) => {
      inFlight += 1;
      max = Math.max(max, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      const data = objects.get(key);
      if (!data) throw new Error(`no object stored under ${key}`);
      return data;
    },
    deleteBatch: async () => [],
    ownsKey: () => true,
    assertOwnedKey: () => undefined,
  };
  return { offloader, maxInFlight: () => max };
}
