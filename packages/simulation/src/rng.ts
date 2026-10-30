/**
 * Seeded randomness for the simulation: a 32-bit FNV-1a hash (arm
 * assignment, stream seeds) and the sfc32 generator. No `Math.random`
 * anywhere: the same seed gives the same cohort, the same behaviour and
 * the same report, on any machine.
 */

/** FNV-1a over the UTF-16 code units of `text`, as an unsigned 32-bit integer. */
export function fnv1a(text: string): number {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** A uniform number in [0, 1) derived from `text` alone (no generator state). */
export function hashUnit(text: string): number {
  return fnv1a(text) / 4_294_967_296;
}

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** True with probability `p` (clamped to [0, 1]). */
  chance(p: number): boolean;
  /** Uniform integer in [min, max], both included. */
  int(min: number, max: number): number;
  /** An index drawn with the given non-negative weights. */
  weighted(weights: readonly number[]): number;
}

/** sfc32 seeded from four FNV-1a hashes of `seed`: independent streams per seed string. */
export function createRng(seed: string): Rng {
  let a = fnv1a(`${seed}#a`);
  let b = fnv1a(`${seed}#b`);
  let c = fnv1a(`${seed}#c`);
  let d = fnv1a(`${seed}#d`);
  function next(): number {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4_294_967_296;
  }
  // Warm up: the first outputs of sfc32 are correlated with the seed words.
  for (let index = 0; index < 12; index += 1) next();
  return {
    next,
    chance(p) {
      if (p <= 0) return false;
      if (p >= 1) return true;
      return next() < p;
    },
    int(min, max) {
      return min + Math.floor(next() * (max - min + 1));
    },
    weighted(weights) {
      const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
      let draw = next() * total;
      for (const [index, weight] of weights.entries()) {
        draw -= Math.max(0, weight);
        if (draw < 0) return index;
      }
      return weights.length - 1;
    },
  };
}
