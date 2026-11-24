// A long simulation run from the command line: `bun run simulate [seed_first] [seeds_count]`.
// The test suite runs a short batch on every `bun test`; this is for hunting.

import { assert } from '../shared/assert'
import { simulate } from './simulator'

const seed_first = Number(process.argv[2] ?? 0)
const seeds_count = Number(process.argv[3] ?? 1000)
const steps_count = Number(process.env.STEPS ?? 500)
const seeds_count_max = 10_000_000

assert(Number.isInteger(seed_first), 'seed_first is an integer')
assert(Number.isInteger(seeds_count), 'seeds_count is an integer')
assert(seeds_count > 0, 'seeds_count is positive')
assert(seeds_count <= seeds_count_max, 'seeds_count is bounded')

for (let seed = seed_first; seed < seed_first + seeds_count; seed += 1) {
  try {
    await simulate({ seed, steps_count })
  } catch (error) {
    console.error(`\nseed ${seed} failed. Replay it with:`)
    console.error(`  SEED=${seed} STEPS=${steps_count} bun test simulation\n`)
    console.error(error)
    process.exit(1)
  }
  if ((seed + 1 - seed_first) % 100 === 0) console.log(`${seed + 1 - seed_first} seeds passed`)
}
console.log(`all ${seeds_count} seeds passed`)
process.exit(0)
