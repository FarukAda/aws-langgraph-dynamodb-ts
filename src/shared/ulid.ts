/**
 * Hides how a sortable, unique id is made from the clock and random bytes.
 *
 * A caller gets ids whose byte order is their creation order, and a prefix
 * that bounds every id from a given millisecond, without knowing the alphabet,
 * the width of the time field or where the randomness comes from. One
 * generator's ids strictly increase whatever the clock does, and a millisecond
 * the encoding cannot hold is refused rather than wrapped.
 */

import { randomBytes } from 'node:crypto';

import { validationError } from './errors/errors';

const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

/**
 * One past the last millisecond ten base-32 characters can hold: `32^10`,
 * which is `2^50`, and lands in the year 37648. Derived rather than written
 * down, so widening {@link TIME_CHARS} moves the rule with it.
 */
export const ULID_TIME_RANGE_MS = ENCODING_LEN ** TIME_CHARS;
/** Bytes drawn per refill of the {@link secureRng} pool: 16 ids per syscall. */
const RNG_POOL_BYTES = 256;

/**
 * A CSPRNG-backed `rng` seam.
 *
 * Accepts: nothing. Each returned generator owns its own pool.
 *
 * Returns: a function yielding uniform values in `[0, 1)`, one byte per call,
 * refilling from `crypto.randomBytes` every {@link RNG_POOL_BYTES} — so a burst
 * of ids costs one syscall per 256 digits rather than one per digit.
 *
 * Throws: whatever `crypto.randomBytes` throws when the platform has no entropy.
 *
 * Guarantees: a digit drawn as `floor(rng() * 32)` is uniform over 0..31 —
 * 256 is a whole multiple of 32, so there is no modulo bias. `Math.random`
 * would order and disambiguate just as well but is not a cryptographically
 * secure source, which the ULID spec asks for in identifier generation.
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
 * The 10 time characters every ULID generated at `timeMs` starts with.
 *
 * Accepts: `timeMs` — epoch milliseconds inside `[0, {@link
 * ULID_TIME_RANGE_MS})`, which is every instant the ten characters can encode.
 *
 * Returns: the prefix, usable as a sort-key bound — every id from that
 * millisecond onward sorts at or after it, every earlier id before it.
 *
 * Throws: `VALIDATION` for a millisecond outside the range, naming no field:
 * no caller-supplied option is at fault here, and the rule a caller meets is
 * `parseMessageWindow`'s, which names `before`. This guard is the invariant
 * underneath it, so no second caller can rebuild the bound that broke.
 *
 * Guarantees: exactly ten characters, all of them from the ULID alphabet.
 * Neither held before. A negative millisecond took a negative remainder into
 * the alphabet and yielded `undefined` per character, so the bound read
 * `undefinedundefined…` — which sorts *above* every real id, since `u` and `d`
 * are both above `Z` — and a window asking for messages before 1969 matched
 * the whole conversation instead of none of it. A millisecond at or past the
 * range wrapped to `0000000000` and matched nothing at all. Both are garbage
 * indistinguishable from a real answer, so both are refused rather than
 * clamped: clamping would hand back the same wrong page under a different
 * name.
 */
export function ulidTimePrefix(timeMs: number): string {
  if (!(timeMs >= 0 && timeMs < ULID_TIME_RANGE_MS)) {
    throw validationError(
      `a ULID time prefix covers epoch milliseconds 0 to ${ULID_TIME_RANGE_MS - 1} (the year ` +
        `37648); ${timeMs} is outside it and has no ten-character encoding`,
    );
  }
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
 * A monotonic ULID generator.
 *
 * Accepts: `now` — epoch milliseconds, default `Date.now`. `rng` — values in
 * `[0, 1)`, default {@link secureRng}. Both are seams for deterministic tests.
 *
 * Returns: a function yielding lexicographically sortable 26-character ids
 * whose first 10 characters encode the millisecond.
 *
 * Throws: whatever `rng` throws.
 *
 * Guarantees: ids from **one** generator strictly increase, whatever the clock
 * does. A clock that advances starts a fresh random component; a clock that
 * stalls or regresses reuses the last timestamp and increments that component;
 * an increment that exhausts all 16 digits carries into the timestamp and draws
 * fresh digits. Two generators — two processes, or two adapter instances —
 * order only by their wall clocks at millisecond precision, so a lagging clock
 * can sort a later id before an earlier one.
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
