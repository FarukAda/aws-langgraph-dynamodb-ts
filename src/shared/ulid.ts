import { randomBytes } from 'node:crypto';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;
/** Bytes drawn per refill of the {@link secureRng} pool: 16 ids per syscall. */
const RNG_POOL_BYTES = 256;

/**
 * A CSPRNG-backed `rng` seam: uniform values in `[0, 1)` from `crypto.randomBytes`,
 * drawn from a refilled pool so a burst of ids costs one syscall per 256
 * digits rather than one per digit. `Math.random` is fine for uniqueness and
 * ordering but is not a cryptographically secure source, which security
 * baselines flag in identifier generation; the ULID spec recommends a CSPRNG.
 */
export function secureRng(): () => number {
  let pool = Buffer.alloc(0);
  let offset = 0;
  return () => {
    if (offset >= pool.length) {
      pool = randomBytes(RNG_POOL_BYTES);
      offset = 0;
    }
    const byte = pool[offset];
    offset += 1;
    return byte / 256;
  };
}

function encodeTime(timeMs: number): string {
  let remaining = Math.floor(timeMs);
  let out = '';
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ENCODING[remaining % ENCODING_LEN] + out;
    remaining = Math.floor(remaining / ENCODING_LEN);
  }
  return out;
}

/**
 * The 10 time characters every ULID generated at `timeMs` starts with. Used
 * as a sort-key bound: every id from that millisecond onwards sorts at or
 * after it, every earlier id before it.
 */
export function ulidTimePrefix(timeMs: number): string {
  return encodeTime(timeMs);
}

function randomDigits(rng: () => number): number[] {
  const digits: number[] = [];
  for (let i = 0; i < RANDOM_CHARS; i++) {
    digits.push(Math.floor(rng() * ENCODING_LEN));
  }
  return digits;
}

/** The incremented random digits, or `overflowed: true` when all digits were at max. */
interface IncrementResult {
  digits: number[];
  overflowed: boolean;
}

function incrementDigits(digits: number[]): IncrementResult {
  const next = [...digits];
  for (let i = RANDOM_CHARS - 1; i >= 0; i--) {
    if (next[i] < ENCODING_LEN - 1) {
      next[i] += 1;
      return { digits: next, overflowed: false };
    }
    next[i] = 0;
  }
  return { digits: next, overflowed: true };
}

/**
 * Build a monotonic ULID generator: lexicographically sortable 26-char ids
 * whose first 10 chars encode the millisecond timestamp. Ids strictly increase
 * even when the clock regresses or the same-millisecond random space overflows:
 * any non-advancing clock reuses the last timestamp and increments the random
 * component, carrying into the timestamp on overflow. `now`/`rng` are seams for
 * deterministic tests; the default `rng` is {@link secureRng}.
 */
export function createUlidFactory(
  now: () => number = Date.now,
  rng: () => number = secureRng(),
): () => string {
  let lastTime = -1;
  let lastRandom: number[] = [];
  return () => {
    const time = now();
    if (time > lastTime) {
      lastTime = time;
      lastRandom = randomDigits(rng);
    } else {
      const result = incrementDigits(lastRandom);
      if (result.overflowed) {
        lastTime += 1;
        lastRandom = randomDigits(rng);
      } else {
        lastRandom = result.digits;
      }
    }
    return encodeTime(lastTime) + lastRandom.map((digit) => ENCODING[digit]).join('');
  };
}
