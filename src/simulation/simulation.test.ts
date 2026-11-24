// Runs the simulator across many seeds. A failure names its seed; replay exactly that run
// with `SEED=<seed> bun test simulation`.

import { expect, test } from 'bun:test'
import { simulate, type Stats } from './simulator'

const seed_fixed = process.env.SEED === undefined ? null : Number(process.env.SEED)
const seeds_count = Number(process.env.SEEDS ?? 40)
const steps_count = Number(process.env.STEPS ?? 300)

async function simulate_seed(seed: number) {
  try {
    return await simulate({ seed, steps_count })
  } catch (error) {
    throw new Error(`seed ${seed}: ${(error as Error).message}`, { cause: error })
  }
}

test('the same seed replays the same run', async () => {
  const seed = seed_fixed ?? 7
  const first = await simulate_seed(seed)
  const second = await simulate_seed(seed)
  expect(second.trace_hash).toBe(first.trace_hash)
  expect(second.stats).toEqual(first.stats)
})

test('different seeds explore different runs', async () => {
  const first = await simulate_seed(1)
  const second = await simulate_seed(2)
  expect(second.trace_hash).not.toBe(first.trace_hash)
})

test('every seed keeps fidelity, durability, convergence and liveness', async () => {
  const total: Record<string, number> = {}
  const seeds = seed_fixed === null
    ? Array.from({ length: seeds_count }, (_, seed) => seed)
    : [seed_fixed]
  for (const seed of seeds) {
    const { stats } = await simulate_seed(seed)
    for (const [name, count] of Object.entries(stats)) total[name] = (total[name] ?? 0) + count
  }
  console.log('simulation totals', total)

  // The invariants mean nothing if the faults never happened. Check the runs were not idle.
  if (seed_fixed === null) {
    for (const name of Object.keys(total) as Array<keyof Stats>) {
      expect(total[name], `${name} happened at least once`).toBeGreaterThan(0)
    }
  }
}, 120_000)
