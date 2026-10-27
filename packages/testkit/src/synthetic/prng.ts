/**
 * Small seeded pseudo-random generator (mulberry32). Deterministic across
 * platforms and Node versions, so the synthetic clinic is reproducible
 * byte for byte from its seed.
 */
export class Prng {
  #state: number;

  constructor(seed: number) {
    this.#state = seed >>> 0;
  }

  /** Uniform float in [0, 1). */
  next(): number {
    this.#state = (this.#state + 0x6d2b79f5) >>> 0;
    let t = this.#state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  }

  /** Uniform integer in [min, max], both inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('pick from an empty list');
    return items[Math.floor(this.next() * items.length)] as T;
  }

  /** Rounds `value` to `decimals` after adding uniform noise in [-spread, spread]. */
  around(value: number, spread: number, decimals = 0): number {
    const factor = 10 ** decimals;
    return Math.round((value + (this.next() * 2 - 1) * spread) * factor) / factor;
  }

  /** A child generator whose sequence depends only on this one's seed and `label`. */
  fork(label: string): Prng {
    let hash = this.#state ^ 0x9e3779b9;
    for (let index = 0; index < label.length; index++) {
      hash = Math.imul(hash ^ label.charCodeAt(index), 0x01000193) >>> 0;
    }
    return new Prng(hash);
  }
}
