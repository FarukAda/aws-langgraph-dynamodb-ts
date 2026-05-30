const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ENCODING_LEN = 32;
const TIME_CHARS = 10;
const RANDOM_CHARS = 16;

function encodeTime(timeMs: number): string {
  let remaining = Math.floor(timeMs);
  let out = '';
  for (let i = 0; i < TIME_CHARS; i++) {
    out = ENCODING[remaining % ENCODING_LEN] + out;
    remaining = Math.floor(remaining / ENCODING_LEN);
  }
  return out;
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
 * deterministic tests.
 */
export function createUlidFactory(
  now: () => number = Date.now,
  rng: () => number = Math.random,
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
