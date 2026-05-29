/** Gzip magic-number bytes, for detecting legacy pre-marker payloads. */
const GZIP_MAGIC = new Uint8Array([0x1f, 0x8b]);

/** 3-byte "LGC" marker stamped on library-compressed payloads. */
export const COMPRESSED_MARKER = new Uint8Array([0x4c, 0x47, 0x43]);

/** True when `data` begins with the library's LGC compression marker. */
export function hasCompressedMarker(data: Uint8Array): boolean {
  if (data.length < COMPRESSED_MARKER.length) return false;
  return COMPRESSED_MARKER.every((byte, index) => data[index] === byte);
}

/** True when `data` begins with the gzip magic number. */
export function isGzipped(data: Uint8Array): boolean {
  return data.length >= 2 && data[0] === GZIP_MAGIC[0] && data[1] === GZIP_MAGIC[1];
}
