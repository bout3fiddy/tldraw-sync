// The single source of chance in a simulation. Everything random derives from one seed.

import { assert } from '../shared/assert'

export class Prng {
  private state: number

  constructor(seed: number) {
    assert(Number.isInteger(seed), 'seed is an integer')
    assert(seed >= 0, 'seed is not negative')
    // Mixed so that neighbouring seeds do not produce neighbouring streams.
    this.state = (Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ 0xc2b2ae35) >>> 0
  }

  // Mulberry32.
  private next_u32(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0
    let mixed = this.state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return (mixed ^ (mixed >>> 14)) >>> 0
  }

  fraction(): number {
    return this.next_u32() / 0x1_0000_0000
  }

  // An integer in [0, bound).
  below(bound: number): number {
    assert(Number.isInteger(bound), 'bound is an integer')
    assert(bound > 0, 'bound is positive')
    return Math.floor(this.fraction() * bound)
  }

  // An integer in [low, high], both inclusive.
  between(low: number, high: number): number {
    assert(low <= high, 'range is not inverted')
    return low + this.below(high - low + 1)
  }

  chance(probability: number): boolean {
    assert(probability >= 0, 'probability is at least zero')
    assert(probability <= 1, 'probability is at most one')
    return this.fraction() < probability
  }
}
