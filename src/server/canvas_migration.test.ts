// A canvas saved in a retired format, brought to native records. The fixtures are state files
// as the boards before scenes wrote them, and `served` is what those boards showed for each
// revision: the hash of its records, taken from that code before it was removed. So these
// tests hold the migration to showing an old board exactly as it was shown, and to losing
// nothing on the way, whatever fails in the middle.

import { expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import ideas_fixture from '../../tests/fixtures/legacy/ideas.cleaned_v1.json'
import interpretation_fixture from '../../tests/fixtures/legacy/interpretation.cleaned_v1.json'
import unified_fixture from '../../tests/fixtures/legacy/unified.canvas_v2.json'
import { document_hash } from '../shared/document_hash'
import { SimulatedCrash, SimulatedDisk } from '../simulation/simulated_disk'
import { scene_example } from '../simulation/test_sketch'
import { Cleaned } from './cleaned'
import { envelope_decode, envelope_encode, file_names, type Disk, type FileName } from './storage'

// The sketch the first layout's versions were made from, and a later one.
const hash = '1'.repeat(16)
const hash_later = '2'.repeat(16)

const served = {
  hand_drawn: 'ba07d0f5e768011d',
  grouped: '6cc90d164658bea6',
  diagram_alone: '481596dd07341d49',
  diagram_with_ideas: '35721d9ac43fd8fd',
  drawing: 'b92edfc50a728b04',
}

function encode(state: object): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(state))
  return envelope_encode({ kind: 'cleaned', label: '-', payload })
}

function state_of(disk: Disk): Record<string, any> {
  const decoded = envelope_decode(disk.read('cleaned.state')!, 'cleaned')

  if (!decoded.ok) throw Error(decoded.reason)

  return JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
}

const interpretation = encode(interpretation_fixture)
const ideas = encode(ideas_fixture)
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

// The unified canvas names the exact copies it was merged from, so its fixture is completed
// with the digests of the two archives as they are encoded here.
const unified = encode({ ...unified_fixture, archives: [digest(interpretation), digest(ideas)] })

function disk_first(with_ideas: boolean): SimulatedDisk {
  const disk = new SimulatedDisk()
  disk.write_atomic('cleaned.state', interpretation)

  if (with_ideas) disk.write_atomic('ideas.state', ideas)

  return disk
}

function disk_unified(): SimulatedDisk {
  const disk = new SimulatedDisk()
  disk.write_atomic('interpretation.archive', interpretation)
  disk.write_atomic('ideas.archive', ideas)
  disk.write_atomic('ideas.state', ideas)
  disk.write_atomic('cleaned.state', unified)
  return disk
}

function copy(disk: Disk): SimulatedDisk {
  const next = new SimulatedDisk()

  for (const name of file_names) {
    const bytes = disk.read(name)

    if (bytes !== null) next.write_atomic(name, bytes)
  }

  return next
}

// What is shown for every kept revision: the current one as served, and each earlier one as
// a restore brings it back.
function shown(disk: Disk, sketch_hash: string): Record<number, string> {
  const document = Cleaned.open(copy(disk)).document(sketch_hash)
  const hashes: Record<number, string> = { [document.revision]: document_hash(document.records) }

  for (const kept of document.history) {
    const canvas = Cleaned.open(copy(disk))
    expect(canvas.restore(document.revision, kept.revision, 0).kind).toBe('restored')
    hashes[kept.revision] = document_hash(canvas.document(sketch_hash).records)
  }

  return hashes
}

test('a cleaned diagram of the first layout is shown as it was, revision by revision', () => {
  const disk = disk_first(false)
  expect(shown(disk, hash)).toEqual({
    1: served.hand_drawn,
    2: served.grouped,
    3: served.diagram_alone,
  })
  const status = Cleaned.open(disk).status(hash)
  expect(status).toMatchObject({ revision: 3, stale: false })
  expect(status.current).toMatchObject({ agent: 'old-agent', legacy: true, shapes_count: 3 })
  expect(status.history.map((kept) => [kept.revision, kept.legacy, kept.summary])).toEqual([
    [1, true, 'Two services and a title.'],
    [2, true, 'An API group.'],
  ])
})

test('the two documents of the first layout become one canvas, and both are kept whole', () => {
  const disk = disk_first(true)
  expect(shown(disk, hash)).toEqual({
    1: served.hand_drawn,
    2: served.grouped,
    3: served.diagram_with_ideas,
  })
  const canvas = Cleaned.open(disk)
  const document = canvas.document(hash)
  expect(document.records.filter((record) => record.typeName === 'binding')).toHaveLength(4)
  expect(document.current).toMatchObject({ source_hash: hash, shapes_count: 6, legacy: true })
  expect(disk.read('interpretation.archive')).toEqual(interpretation)
  expect(disk.read('ideas.archive')).toEqual(ideas)
  expect(disk.read('ideas.state')).toEqual(ideas)

  // What is saved now is the records themselves: no shape list is read again.
  const saved = state_of(disk)
  expect(saved.format).toBe('tldraw-sync.canvas.v3')
  expect(saved.current.records).toHaveLength(document.records.length)
  expect(JSON.stringify(saved)).not.toContain('"shapes"')
  expect(JSON.stringify(saved)).not.toContain('"diagram"')
  expect(Cleaned.open(disk).document(hash)).toEqual(document)
})

test('a unified canvas is shown as it was, drawing and restore included, and kept whole', () => {
  const disk = disk_unified()
  expect(shown(disk, hash_later)).toEqual({
    1: served.hand_drawn,
    2: served.grouped,
    3: served.diagram_with_ideas,
    4: served.drawing,
    5: served.diagram_with_ideas,
  })
  const canvas = Cleaned.open(disk)
  const status = canvas.status(hash_later)
  expect(status).toMatchObject({ revision: 5, stale: true })
  expect(status.current).toMatchObject({ source_hash: hash, restored_from: 3, legacy: true })
  expect(status.history.map((kept) => kept.revision)).toEqual([1, 2, 3, 4])
  expect(status.history.every((kept) => kept.legacy)).toBe(true)

  // The file the board moved on from is kept byte for byte, beside the two it pointed at.
  expect(disk.read('canvas.archive')).toEqual(unified)
  expect(disk.read('interpretation.archive')).toEqual(interpretation)
  expect(disk.read('ideas.archive')).toEqual(ideas)
  expect(state_of(disk).format).toBe('tldraw-sync.canvas.v3')

  // The drawing kept in revision 4 comes back as the person's two pen strokes.
  expect(canvas.restore(5, 4, 0)).toMatchObject({ kind: 'restored', revision: 6 })
  const strokes = canvas
    .document(hash_later)
    .records.filter((record) => (record as { type?: string }).type === 'draw')
  expect(strokes.map((stroke) => stroke.id)).toEqual(['shape:cleaned-pic.0', 'shape:cleaned-pic.1'])
})

// Each failure schedule interrupts one durable write. Reopening must finish the migration
// without dropping a revision, changing an archive, or showing anything differently.
test('an interrupted migration is finished on the next start, with nothing lost', () => {
  const schedules: Array<[() => SimulatedDisk, string, Array<FileName | null>]> = [
    [
      () => disk_first(true),
      hash,
      [null, 'interpretation.archive', 'ideas.archive', 'cleaned.state'],
    ],
    [disk_unified, hash_later, [null, 'canvas.archive', 'cleaned.state']],
  ]

  for (const [make, sketch_hash, faults] of schedules) {
    const expected = shown(make(), sketch_hash)

    for (const fault of faults) {
      const disk = make()
      const before = disk.read('cleaned.state')
      const broken: Disk = {
        read: (name) => disk.read(name),
        write_atomic(name, bytes) {
          if (name === fault) throw new SimulatedCrash()

          disk.write_atomic(name, bytes)
        },
      }

      if (fault !== null) {
        expect(() => Cleaned.open(broken)).toThrow(SimulatedCrash)
        expect(disk.read('cleaned.state')).toEqual(before)
      }

      expect(shown(disk, sketch_hash)).toEqual(expected)
      Cleaned.open(disk)
      expect(state_of(disk).format).toBe('tldraw-sync.canvas.v3')
      expect(shown(disk, sketch_hash)).toEqual(expected)
      expect(disk.read('interpretation.archive')).toEqual(interpretation)
      expect(disk.read('ideas.archive')).toEqual(ideas)
    }
  }
})

test('an archive that does not match the file in place stops the start', () => {
  const disk = disk_unified()
  disk.write_atomic('canvas.archive', interpretation)
  expect(() => Cleaned.open(disk)).toThrow(/Conflicting canvas archive/)
  expect(disk.read('cleaned.state')).toEqual(unified)
  expect(disk.read('canvas.archive')).toEqual(interpretation)

  const first = disk_first(true)
  first.write_atomic('ideas.archive', interpretation)
  expect(() => Cleaned.open(first)).toThrow(/Conflicting ideas archive/)
  expect(first.read('cleaned.state')).toEqual(interpretation)
})

test('a unified canvas that does not match its archives, or points past them, is refused', () => {
  const stray = disk_unified()
  stray.write_atomic('cleaned.state', encode({ ...unified_fixture, archives: [null, null] }))
  expect(() => Cleaned.open(stray)).toThrow(/does not match its archives/)

  const pointer = { migrated: true, revision: 2, published_at_ms: 0, restored_from: null }
  const early = disk_unified()
  const archives = [digest(interpretation), digest(ideas)]
  early.write_atomic(
    'cleaned.state',
    encode({ ...unified_fixture, revision: 2, current: pointer, history: [], archives }),
  )
  expect(() => Cleaned.open(early)).toThrow(/Damaged migration reference/)
  expect(early.read('canvas.archive')).toBeNull()
})

test('the old limits apply to every revision of the first layout before any write', () => {
  for (const [file, count] of [
    ['cleaned.state', 401],
    ['ideas.state', 257],
  ] as const) {
    const state = structuredClone(interpretation_fixture) as Record<string, any>
    const shape = state.history[0].shapes[1]
    state.history[0].shapes = Array.from({ length: count }, (_, index) => {
      return { ...shape, id: `n${index}`, x: 200 * index }
    })
    const disk = disk_first(false)
    const oversized = encode(state)
    disk.write_atomic(file, oversized)
    expect(() => Cleaned.open(disk)).toThrow(/Invalid legacy/)
    expect(disk.read(file)).toEqual(oversized)
    expect(disk.read('interpretation.archive')).toBeNull()
    expect(disk.read('ideas.archive')).toBeNull()
  }
})

test('a saved shape that cannot be drawn stops the start, and the file stays', () => {
  for (const damage of [
    (shape: Record<string, unknown>) => (shape.color = 'mauve'),
    (shape: Record<string, unknown>) => (shape.w = 0),
    (shape: Record<string, unknown>) => (shape.script = 'alert(1)'),
  ]) {
    const state = structuredClone(interpretation_fixture) as Record<string, any>
    damage(state.current.shapes[1])
    const disk = new SimulatedDisk()
    const bytes = encode(state)
    disk.write_atomic('cleaned.state', bytes)
    expect(() => Cleaned.open(disk)).toThrow(/a version is malformed/)
    expect(disk.read('cleaned.state')).toEqual(bytes)
    expect(disk.read('interpretation.archive')).toBeNull()
  }
})

// A revision from a retired format has no controls: one view, its records as they were.
test('a migrated revision has one view, and a page asking for another is told so', () => {
  const canvas = Cleaned.open(disk_unified())
  const view = canvas.view(null)
  expect(view).toMatchObject({ kind: 'view', view: { controls: [], states_count: 1, taps: [] } })
  expect(view.kind === 'view' ? view.view.records : null).toEqual(
    canvas.document(hash_later).records,
  )
  expect(canvas.view({ season: 'winter' })).toMatchObject({ kind: 'invalid', path: 'state.season' })
  expect(canvas.controls_current()).toEqual([])
})

test('a scene is published over a migrated canvas, which stays in the history as it was', () => {
  const disk = disk_unified()
  const canvas = Cleaned.open(disk)

  // A revision from a retired format has no scene to edit, and holds no strokes to carry.
  expect(canvas.scene_current()).toBeNull()
  const carried = {
    ...scene_example(hash_later, 5),
    basis: 'canvas',
    elements: [{ type: 'sketch', id: 'pic', strokes: ['shape:hill', 'shape:sun'] }],
  }
  expect(canvas.publish(carried, hash_later, 'default', 0)).toMatchObject({
    kind: 'invalid',
    path: 'elements[0]',
  })

  const published = canvas.publish(scene_example(hash_later, 5), hash_later, 'default', 7000)
  expect(published).toMatchObject({ kind: 'published', revision: 6 })
  const status = canvas.status(hash_later)
  expect(status.current).toMatchObject({ legacy: false, source_hash: hash_later })
  expect(status.history.map((kept) => [kept.revision, kept.legacy])).toEqual([
    [1, true],
    [2, true],
    [3, true],
    [4, true],
    [5, true],
  ])

  // After a restart the old revisions are still there, and still shown as they were.
  const reopened = Cleaned.open(disk)
  expect(reopened.scene_current()).toHaveLength(4)
  expect(reopened.restore(6, 5, 8000)).toMatchObject({ kind: 'restored', revision: 7 })
  expect(document_hash(reopened.document(hash_later).records)).toBe(served.diagram_with_ideas)
  expect(reopened.status(hash_later).current).toMatchObject({ legacy: true, restored_from: 5 })
})
