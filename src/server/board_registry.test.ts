// Board sessions through the production registry, on simulated disks and a virtual clock: a
// data directory from before sessions, isolation between boards, proposals bound to the board
// of their snapshot, titles that never beat a person's name, bounded open boards, damage, and a
// seeded run of all of it with restarts and disk faults. Replay one run with SEED=<seed>.

import { expect, test } from 'bun:test'
import type { WebSocketMinimal } from '@tldraw/sync-core'
import { board_default_id } from '../shared/board_session'
import { board_sessions_count_max, boards_open_count_max } from '../shared/constants'
import { Prng } from '../simulation/prng'
import { SimulatedCrash } from '../simulation/simulated_disk'
import {
  registry_environment_simulated,
  type SimulatedRegistryEnvironment,
} from '../simulation/simulated_registry'
import { scene_example, sketch_disk, sketch_square } from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import type { Board } from './board'
import { BoardRegistry } from './board_registry'
import { envelope_encode, StorageError } from './storage'

const seed_fixed = process.env.SEED === undefined ? null : Number(process.env.SEED)
const seeds_count = Number(process.env.SEEDS ?? 24)
const steps_count = 120

// Every board here starts from the same one-square sketch, so every board has the same hash:
// only the session can tell their proposals apart.
const square = () => sketch_square('shape:a', 0)

function environment(): SimulatedRegistryEnvironment {
  return registry_environment_simulated(new VirtualTime(), sketch_disk([square()]))
}

// A new board, holding the same sketch as every other, opened on first use.
function board_create(
  registry: BoardRegistry,
  env: SimulatedRegistryEnvironment,
  name: string | null = null,
): string {
  const created = registry.create(name)

  if (created.kind !== 'created') throw new Error('the registry is full')

  env.disks.set(created.session.id, sketch_disk([square()]))
  return created.session.id
}

function board_of(registry: BoardRegistry, id: string): Board {
  const lookup = registry.board(id)

  if (lookup.kind !== 'board') throw new Error(`board ${id} is ${lookup.kind}`)

  return lookup.board
}

function proposal_for(board: Board, session: string, title: string | null = null) {
  const hash = board.document_state().hash
  const base = scene_example(hash, board.cleaned_status().revision, 'Checkout', session)
  return { ...base, ...(title === null ? {} : { title }) }
}

const socket_idle: WebSocketMinimal = { readyState: 1, send: () => undefined, close: () => {} }

test('a data directory from before sessions opens as the default board, unchanged', () => {
  const env = environment()
  const registry = BoardRegistry.open(env)
  expect(registry.list()).toEqual([
    { id: board_default_id, name: null, named_by: null, created_at_ms: 0 },
  ])
  expect(
    board_of(registry, board_default_id)
      .shapes()
      .map((shape) => shape.id),
  ).toEqual(['shape:a'])

  // Nothing is written for sessions until one is made: the old layout stays as it was.
  expect(env.disk.read('sessions.registry')).toBeNull()
  const board = registry.board_open(board_default_id) as Board
  const published = registry.publish(board_default_id, proposal_for(board, board_default_id))
  expect(published).toMatchObject({ kind: 'published', revision: 1, title_applied: false })
  expect(env.disk.read('sessions.registry')).toBeNull()
  registry.close()
})

test('boards are separate, and a restart keeps each board, its name and its diagram', () => {
  const env = environment()
  const registry = BoardRegistry.open(env)
  const one = board_create(registry, env, null)
  const two = board_create(registry, env, null)
  expect(registry.rename(two, 'Checkout flow')).toMatchObject({ kind: 'renamed' })
  expect(registry.rename('ffffffffffffffff', 'Nowhere')).toEqual({ kind: 'not_found' })

  const board_one = board_of(registry, one)
  expect(registry.publish(one, proposal_for(board_one, one))).toMatchObject({ revision: 1 })
  expect(board_of(registry, two).cleaned_status().revision).toBe(0)
  expect(board_of(registry, board_default_id).cleaned_status().revision).toBe(0)
  registry.close()

  const restarted = BoardRegistry.open(env)
  expect(restarted.list().map((session) => [session.id, session.name])).toEqual([
    [board_default_id, null],
    [one, null],
    [two, 'Checkout flow'],
  ])
  expect(board_of(restarted, one).cleaned_status().revision).toBe(1)
  expect(board_of(restarted, two).cleaned_status().revision).toBe(0)
  restarted.close()
})

// The escaped-bug guard for replay: both boards hold the same sketch at revision 0, so the hash
// and the revision of one board's snapshot are also right for the other.
test('a proposal is refused by every board but the one its snapshot came from', () => {
  const env = environment()
  const registry = BoardRegistry.open(env)
  const one = board_create(registry, env)
  const two = board_create(registry, env)
  const board_one = board_of(registry, one)
  const board_two = board_of(registry, two)
  expect(board_one.document_state().hash).toBe(board_two.document_state().hash)

  const for_one = proposal_for(board_one, one, 'Payments')
  expect(registry.publish(two, for_one)).toEqual({
    kind: 'session_mismatch',
    session: two,
    title_applied: false,
  })
  expect(registry.publish(board_default_id, for_one)).toMatchObject({ kind: 'session_mismatch' })

  // A scene always names its board: one that names none is refused by every board.
  const { session: _, ...unbound } = proposal_for(board_two, two)
  const nameless = { kind: 'invalid', path: 'proposal.session' }
  expect(registry.publish(two, unbound)).toMatchObject(nameless)
  expect(registry.publish(board_default_id, unbound)).toMatchObject(nameless)
  expect(board_two.cleaned_status().revision).toBe(0)
  expect(registry.find(two)?.name).toBeNull()

  // A draft is bound to its board the same way, and names nothing.
  expect(registry.preview(two, for_one)).toEqual({ kind: 'session_mismatch', session: two })
  expect(registry.preview(one, for_one)).toMatchObject({ kind: 'preview', base_revision: 0 })
  expect(registry.find(one)?.name).toBeNull()
  expect(board_one.cleaned_status().revision).toBe(0)

  expect(registry.publish(one, for_one)).toMatchObject({ kind: 'published', title_applied: true })
  expect(registry.find(one)?.name).toBe('Payments')
  registry.close()
})

test('a title names only a board still unnamed when its publish is accepted', () => {
  const env = environment()
  const registry = BoardRegistry.open(env)
  const untitled = board_create(registry, env)
  const renamed = board_create(registry, env)
  const board = board_of(registry, untitled)

  // A refused publish names nothing, however good its title.
  const stale = { ...proposal_for(board, untitled, 'Stale title'), snapshot: '0000000000000000' }
  expect(registry.publish(untitled, stale)).toMatchObject({ kind: 'sketch_changed' })
  expect(registry.find(untitled)?.name).toBeNull()

  const spaced = proposal_for(board, untitled, '  Order   flow ')
  expect(registry.publish(untitled, spaced)).toMatchObject({
    kind: 'published',
    title_applied: true,
  })
  expect(registry.find(untitled)).toMatchObject({ name: 'Order flow', named_by: 'agent' })
  expect(registry.publish(untitled, proposal_for(board, untitled, 'Later'))).toMatchObject({
    kind: 'published',
    title_applied: false,
  })
  expect(registry.find(untitled)?.name).toBe('Order flow')

  // The race: the snapshot asked for a title, then a person named the board first.
  const other = board_of(registry, renamed)
  const proposal = proposal_for(other, renamed, 'Agent title')
  registry.rename(renamed, 'Mine')
  expect(registry.publish(renamed, proposal)).toMatchObject({
    kind: 'published',
    title_applied: false,
  })
  expect(registry.find(renamed)).toMatchObject({ name: 'Mine', named_by: 'person' })

  // And a person renames over an agent's title whenever they like.
  expect(registry.rename(untitled, 'Ours')).toMatchObject({ kind: 'renamed' })
  expect(registry.find(untitled)).toMatchObject({ name: 'Ours', named_by: 'person' })
  registry.close()
})

test('a title that cannot be saved is left off, and the publish stands', () => {
  const env = environment()
  const registry = BoardRegistry.open(env)
  const id = board_create(registry, env)
  const board = board_of(registry, id)
  const kept = env.disk.read('sessions.registry')

  env.disk.write_fault_armed = true
  expect(registry.publish(id, proposal_for(board, id, 'Lost'))).toMatchObject({
    kind: 'published',
    revision: 1,
    title_applied: false,
  })
  expect(env.disk.read('sessions.registry')).toEqual(kept)
  expect(registry.find(id)?.name).toBeNull()
  registry.close()

  const restarted = BoardRegistry.open(env)
  expect(restarted.find(id)?.name).toBeNull()
  expect(board_of(restarted, id).cleaned_status().revision).toBe(1)
  restarted.close()
})

test('only a few boards are open; idle ones are set aside, busy ones refuse a new one', () => {
  const env = environment()
  const registry = BoardRegistry.open(env)
  const ids = Array.from({ length: boards_open_count_max + 2 }, () => board_create(registry, env))

  // Opening every board, one after another, keeps the bound by closing idle boards.
  for (const id of ids) {
    const board = board_of(registry, id)
    expect(registry.publish(id, proposal_for(board, id))).toMatchObject({ kind: 'published' })
    expect(registry.open_count()).toBeLessThanOrEqual(boards_open_count_max)
  }

  for (const id of ids) expect(board_of(registry, id).cleaned_status().revision).toBe(1)

  // Every open board in use: the next one is refused, and none is closed under a page.
  const busy = ids.slice(-(boards_open_count_max - 1))

  for (const id of busy) {
    expect(board_of(registry, id).session_open(`pen-${id}`, 'draw', socket_idle)).toBe(true)
  }

  expect(registry.board(ids[0] as string)).toEqual({ kind: 'busy' })

  for (const id of busy) expect(registry.board_open(id)?.idle()).toBe(false)

  board_of(registry, busy[0] as string).session_close(`pen-${busy[0]}`, socket_idle)
  expect(registry.board(ids[0] as string).kind).toBe('board')
  registry.destroy()
})

test('the number of boards is bounded, and names are plain text on one line', () => {
  const env = environment()
  const registry = BoardRegistry.open(env)

  for (let count = 1; count < board_sessions_count_max; count += 1) board_create(registry, env)

  expect(registry.list().length).toBe(board_sessions_count_max)
  expect(registry.create(null)).toEqual({ kind: 'full' })
  expect(() => registry.create('two\nlines')).toThrow('clean name')
  registry.destroy()
})

test('a damaged registry stops the start; a damaged board is refused alone', () => {
  const env = environment()
  const registry = BoardRegistry.open(env)
  const id = board_create(registry, env)
  registry.close()

  const damaged = env.disk.read('sessions.registry') as Uint8Array
  byte_flip(damaged, damaged.length - 2)
  env.disk.write_atomic('sessions.registry', damaged)
  expect(() => BoardRegistry.open(env)).toThrow(StorageError)

  const payload = new TextEncoder().encode(
    JSON.stringify({
      format: 'tldraw-sync.sessions.v1',
      sessions: [
        { id: board_default_id, name: null, named_by: null, created_at_ms: 0 },
        {
          id,
          name: null,
          named_by: null,
          created_at_ms: 0,
        },
      ],
    }),
  )
  env.disk.write_atomic(
    'sessions.registry',
    envelope_encode({
      kind: 'registry',
      label: '-',
      payload,
    }),
  )
  const board_file = env.disks.get(id)?.read('board.snapshot') as Uint8Array
  byte_flip(board_file, board_file.length - 1)
  env.disks.get(id)?.write_atomic('board.snapshot', board_file)
  const reopened = BoardRegistry.open(env)
  expect(reopened.board(id)).toMatchObject({ kind: 'damaged' })
  expect(reopened.board(board_default_id).kind).toBe('board')
  reopened.destroy()
})

function byte_flip(bytes: Uint8Array, index: number): void {
  bytes.set([(bytes[index] as number) ^ 0xff], index)
}

// The model the seeded run checks the registry against, and what the run did.
type Model = Map<string, { name: string | null; named_by: string | null; revision: number }>
type Counts = {
  created: number
  renamed: number
  published: number
  titled: number
  refused: number
  restarted: number
  faults: number
}

function seed_run(seed: number): Counts {
  const prng = new Prng(seed)
  const env = environment()
  let registry = BoardRegistry.open(env)
  const model: Model = new Map([[board_default_id, { name: null, named_by: null, revision: 0 }]])
  const counts: Counts = {
    created: 0,
    renamed: 0,
    published: 0,
    titled: 0,
    refused: 0,
    restarted: 0,
    faults: 0,
  }

  for (let step = 0; step < steps_count; step += 1) {
    const ids = [...model.keys()]
    const id = ids[prng.below(ids.length)] as string
    const source = prng.chance(0.25) ? (ids[prng.below(ids.length)] as string) : id
    const choice = prng.below(10)

    // A fault in the data directory: the registry's file, and the default board's.
    env.disk.write_fault_armed = choice < 9 && prng.chance(0.08)

    try {
      if (choice < 2 && ids.length < 12) {
        const name = prng.chance(0.3) ? `Board ${step}` : null
        const created = board_create(registry, env, name)
        model.set(created, { name, named_by: name === null ? null : 'person', revision: 0 })
        counts.created += 1
      } else if (choice < 4) {
        registry.rename(id, `Named ${step}`)
        model.set(id, { ...model.get(id)!, name: `Named ${step}`, named_by: 'person' })
        counts.renamed += 1
      } else if (choice < 9) {
        step_publish(registry, model, counts, id, source, prng.chance(0.6) ? `Title ${step}` : null)
      } else {
        registry.destroy()
        registry = BoardRegistry.open(env)
        counts.restarted += 1
      }
    } catch (error) {
      if (!(error instanceof SimulatedCrash)) throw error

      counts.faults += 1
    }

    env.disk.write_fault_armed = false
    model_check(registry, model, `seed ${seed} step ${step}`)
  }

  registry.destroy()
  return counts
}

function step_publish(
  registry: BoardRegistry,
  model: Model,
  counts: Counts,
  id: string,
  source: string,
  title: string | null,
): void {
  const proposal = proposal_for(board_of(registry, source), source, title)
  const result = registry.publish(id, proposal)
  const entry = model.get(id)!

  if (source !== id) {
    expect(result.kind).toBe('session_mismatch')
    counts.refused += 1
    return
  }

  expect(result.kind).toBe('published')
  const titled =
    title !== null && entry.name === null && 'title_applied' in result && result.title_applied
  model.set(id, {
    name: titled ? title : entry.name,
    named_by: titled ? 'agent' : entry.named_by,
    revision: entry.revision + 1,
  })
  counts.published += 1

  if (titled) counts.titled += 1
}

function model_check(registry: BoardRegistry, model: Model, label: string): void {
  expect(
    registry.list().map((session) => session.id),
    label,
  ).toEqual([...model.keys()])

  for (const session of registry.list()) {
    const entry = model.get(session.id)!
    expect([session.name, session.named_by], label).toEqual([entry.name, entry.named_by])
  }

  expect(registry.open_count(), label).toBeLessThanOrEqual(boards_open_count_max)
  const [id, entry] = [...model.entries()][model.size - 1]!
  expect(board_of(registry, id).cleaned_status().revision, label).toBe(entry.revision)
}

test('seeded: names, titles, isolation and revisions survive restarts and disk faults', () => {
  const seeds =
    seed_fixed === null ? Array.from({ length: seeds_count }, (_, seed) => seed) : [seed_fixed]
  const total: Record<string, number> = {}

  for (const seed of seeds) {
    for (const [name, count] of Object.entries(seed_run(seed))) {
      total[name] = (total[name] ?? 0) + count
    }
  }

  console.log('registry simulation totals', total)

  if (seed_fixed === null) {
    for (const [name, count] of Object.entries(total)) {
      expect(count, `${name} happened at least once`).toBeGreaterThan(0)
    }
  }
}, 60_000)
