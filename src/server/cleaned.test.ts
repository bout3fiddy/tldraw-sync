// The Agent canvas through the production board, on an injected disk and clock: publishing a
// scene, both kinds of conflict, a change to the canvas alone, strokes copied from the sketch,
// drafts, a crash in the middle of a publish, restarts, damage, restores, and a seeded run of
// all of them checked against a model.

import { expect, test } from 'bun:test'
import { cleaned_history_count_max, ink_points_count_max } from '../shared/constants'
import { document_hash } from '../shared/document_hash'
import { Prng } from '../simulation/prng'
import { SimulatedCrash, SimulatedDisk } from '../simulation/simulated_disk'
import {
  scene_example,
  sketch_disk,
  sketch_save,
  sketch_square,
  sketch_stroke,
} from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import { Board, StorageError } from './board'
import { envelope_encode } from './storage'

type Json = Record<string, any>

function board_open(disk: SimulatedDisk): Board {
  return Board.open({ time: new VirtualTime(), disk })
}

function ink(board: Board) {
  const { clock, hash } = board.document_state()
  return { clock, hash, shapes: JSON.stringify(board.shapes()) }
}

const records_of = (board: Board) => board.cleaned_document().records as unknown as Json[]

test('a board that never had a canvas opens with nothing published', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const status = board.cleaned_status()
  expect(status).toMatchObject({ revision: 0, current: null, stale: false, history: [] })
  expect(board.cleaned_document().records).toEqual([])
  expect(disk.read('cleaned.state')).toBeNull()
  expect(board.shapes().map((shape) => shape.id)).toEqual(['shape:a'])
  board.destroy()
})

test('a publish replaces the canvas whole and leaves the ink untouched', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const before = ink(board)
  const result = board.cleaned_publish(scene_example(before.hash, 0))
  expect(result).toMatchObject({ kind: 'published', revision: 1, shapes_count: 4, title: null })
  expect(ink(board)).toEqual(before)

  const document = board.cleaned_document()
  expect(document.revision).toBe(1)
  expect(document.stale).toBe(false)
  expect(document.current).toMatchObject({
    revision: 1,
    source_hash: before.hash,
    agent: 'test-agent',
    restored_from: null,
    shapes_count: 4,
    legacy: false,
  })
  expect(document.records.map((record) => record.id).sort()).toEqual([
    'binding:scene-writes-end',
    'binding:scene-writes-start',
    'shape:scene-api',
    'shape:scene-db',
    'shape:scene-title',
    'shape:scene-writes',
  ])
  expect(result).toMatchObject({ records_hash: document_hash(document.records) })
  board.destroy()
})

test('a scene made from an older sketch is refused, and nothing changes', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const result = board.cleaned_publish(scene_example('0000000000000000', 0))
  expect(result).toEqual({ kind: 'sketch_changed', sketch_hash: board.document_state().hash })
  expect(board.cleaned_status().revision).toBe(0)
  board.destroy()
})

test('two agents publishing from the same revision: the second is refused', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const hash = board.document_state().hash
  expect(board.cleaned_publish(scene_example(hash, 0, 'First')).kind).toBe('published')
  const second = board.cleaned_publish(scene_example(hash, 0, 'Second'))
  expect(second).toEqual({ kind: 'revision_conflict', revision: 1 })
  const title = board.cleaned_document().records.find((r) => r.id === 'shape:scene-title')
  expect(JSON.stringify(title)).toContain('First')
  board.destroy()
})

test('a scene for another board is refused before its sketch or revision is looked at', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const scene = scene_example('0000000000000000', 9, 'Elsewhere', 'abcdabcdabcdabcd')
  expect(board.cleaned_publish(scene)).toEqual({ kind: 'session_mismatch', session: 'default' })
  expect(board.cleaned_status().revision).toBe(0)
  board.destroy()
})

test('an invalid scene is refused before anything is written', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const scene = scene_example(board.document_state().hash, 0)
  scene.elements[3] = { ...scene.elements[3]!, to: 'missing' }
  const result = board.cleaned_publish(scene)
  expect(result).toMatchObject({ kind: 'invalid', path: 'elements[3].to' })
  expect(disk.read('cleaned.state')).toBeNull()
  board.destroy()
})

// The canvas alone can change after the sketch has moved on. Such a publish is still guarded
// by the revision, and it never claims to have read the sketch.
test('a change to the canvas alone is accepted after the sketch moved on', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  let board = board_open(disk)
  const first_hash = board.document_state().hash
  board.cleaned_publish(scene_example(first_hash, 0, 'From the sketch'))
  board.destroy()
  sketch_save(disk, [sketch_square('shape:a', 0), sketch_square('shape:b', 40)])
  board = board_open(disk)
  const later_hash = board.document_state().hash
  expect(later_hash).not.toBe(first_hash)
  expect(board.cleaned_status().stale).toBe(true)

  const stale_reading = scene_example(first_hash, 1, 'Still from the old sketch')
  expect(board.cleaned_publish(stale_reading)).toMatchObject({ kind: 'sketch_changed' })
  const own = { ...scene_example(first_hash, 1, 'My own note'), basis: 'canvas' }
  expect(board.cleaned_publish({ ...own, base_revision: 0 })).toMatchObject({
    kind: 'revision_conflict',
  })
  expect(board.cleaned_publish(own)).toMatchObject({ kind: 'published', revision: 2 })
  const status = board.cleaned_status()
  expect(status.current).toMatchObject({ source_hash: first_hash, revision: 2 })
  expect(status.stale).toBe(true)
  expect(JSON.stringify(board.cleaned_document().records)).toContain('My own note')

  // Made from the sketch as it is now, the canvas is current again.
  const fresh = scene_example(later_hash, 2, 'From the new sketch')
  expect(board.cleaned_publish(fresh)).toMatchObject({ kind: 'published', revision: 3 })
  expect(board.cleaned_status()).toMatchObject({ stale: false })
  expect(board.cleaned_status().current?.source_hash).toBe(later_hash)
  board.destroy()
})

test('an empty scene publishes an empty canvas, a revision like any other', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const hash = board.document_state().hash
  board.cleaned_publish(scene_example(hash, 0))
  const cleared = board.cleaned_publish({ ...scene_example(hash, 1), elements: [] })
  expect(cleared).toMatchObject({ kind: 'published', revision: 2, shapes_count: 0 })
  expect(board.cleaned_document()).toMatchObject({ revision: 2, records: [] })
  expect(board.sketch_snapshot(hash)).toMatchObject({ scene: [], agent_revision: 2 })
  expect(board.cleaned_restore(2, 1)).toMatchObject({ kind: 'restored', revision: 3 })
  expect(board.cleaned_document().records).toHaveLength(6)
  board.destroy()
})

const hill = sketch_stroke('shape:hill', 300, 200, [
  [0, 0],
  [60, -40],
  [140, 0],
])
const sun = sketch_stroke(
  'shape:sun',
  400,
  20,
  [
    [0, 0],
    [30, 0],
    [30, 30],
    [0, 30],
  ],
  'red',
)

function picture(hash: string, base_revision: number, extra: Json = {}) {
  const sketch = { type: 'sketch', id: 'pic', strokes: ['shape:hill', 'shape:sun'], ...extra }
  const caption = { type: 'text', id: 'cap', x: 300, y: 260, text: 'A hill under the sun' }
  return { ...scene_example(hash, base_revision), elements: [sketch, caption] as Json[] }
}

test('sketch strokes are copied by the board, sample for sample, with where they came from', () => {
  const disk = sketch_disk([hill, sun])
  const board = board_open(disk)
  const hash = board.document_state().hash
  const before = ink(board)
  expect(board.cleaned_publish(picture(hash, 0))).toMatchObject({ kind: 'published' })
  expect(ink(board)).toEqual(before)
  const strokes = records_of(board).filter((record) => record.type === 'draw')
  expect(strokes.map((stroke) => [stroke.id, stroke.x, stroke.y])).toEqual([
    ['shape:scene-pic.0', 300, 200],
    ['shape:scene-pic.1', 400, 20],
  ])
  expect(strokes.map((stroke) => stroke.props)).toEqual([hill, sun].map((s) => (s as Json).props))
  expect(strokes.map((stroke) => stroke.meta)).toEqual([
    { sketch_stroke: 'shape:hill', sketch_hash: hash },
    { sketch_stroke: 'shape:sun', sketch_hash: hash },
  ])

  // The snapshot hands the scene back with what the board filled in, and without the samples.
  const [held] = board.sketch_snapshot(hash)!.scene!
  expect(held).toEqual({
    type: 'sketch',
    id: 'pic',
    strokes: ['shape:hill', 'shape:sun'],
    x: 295,
    y: 15,
    w: 150,
    h: 190,
    source_hash: hash,
  })
  board.destroy()

  // After a restart the strokes are still the person's own.
  const reopened = board_open(disk)
  expect(records_of(reopened).filter((record) => record.type === 'draw')).toEqual(strokes)
  reopened.destroy()
})

test('an agent cannot send pen samples as the sketch, or name a stroke the sketch lacks', () => {
  const board = board_open(sketch_disk([hill, sun, sketch_square('shape:box', 0)]))
  const hash = board.document_state().hash
  const forged = picture(hash, 0, { ink: [{ type: 'draw', x: 0, y: 0, props: {} }] })
  expect(board.cleaned_publish(forged)).toMatchObject({ kind: 'invalid', path: 'elements[0].ink' })

  for (const [strokes, where] of [
    [['shape:hill', 'shape:gone'], 'elements[0].strokes[1]'],
    [['shape:box'], 'elements[0].strokes[0]'],
  ] as const) {
    const result = board.cleaned_publish(picture(hash, 0, { strokes }))
    expect(result).toMatchObject({ kind: 'invalid', path: where })
  }

  expect(board.cleaned_status().revision).toBe(0)
  board.destroy()
})

test('copied strokes move with their element and are kept by a change to the canvas alone', () => {
  const disk = sketch_disk([hill, sun])
  let board = board_open(disk)
  const hash = board.document_state().hash
  board.cleaned_publish(picture(hash, 0, { x: 1000, y: 500 }))
  const placed = records_of(board).filter((record) => record.type === 'draw')
  expect(placed.map((stroke) => [stroke.x, stroke.y])).toEqual([
    [1005, 685],
    [1105, 505],
  ])
  board.destroy()

  // The person erases the hill. A new reading of the sketch cannot keep it; the canvas can.
  sketch_save(disk, [sun])
  board = board_open(disk)
  const later = board.document_state().hash
  expect(board.cleaned_publish(picture(later, 1))).toMatchObject({
    kind: 'invalid',
    path: 'elements[0].strokes[0]',
  })
  const moved = { ...picture(hash, 1, { x: 0, y: 0 }), basis: 'canvas' }
  expect(board.cleaned_publish(moved)).toMatchObject({ kind: 'published', revision: 2 })
  const kept = records_of(board).filter((record) => record.type === 'draw')
  expect(kept.map((stroke) => [stroke.x, stroke.y])).toEqual([
    [5, 185],
    [105, 5],
  ])
  expect(kept.map((stroke) => stroke.props)).toEqual(placed.map((stroke) => stroke.props))
  expect(kept.every((stroke) => stroke.meta.sketch_hash === hash)).toBe(true)
  expect(board.cleaned_status().current?.source_hash).toBe(hash)

  // A change to the canvas alone cannot bring in strokes the canvas does not already hold.
  const renamed = { ...picture(hash, 2, { strokes: ['shape:sun'] }), basis: 'canvas' }
  expect(board.cleaned_publish(renamed)).toMatchObject({ kind: 'invalid', path: 'elements[0]' })
  board.destroy()
})

test("one canvas keeps a bounded number of pen samples, the agent's own included", () => {
  const samples = Array.from({ length: 2000 }, (_, index) => [index, index % 7] as const)
  const board = board_open(sketch_disk([sketch_stroke('shape:long', 0, 0, samples)]))
  const hash = board.document_state().hash
  const own_count = ink_points_count_max - 1999
  const own = Array.from({ length: own_count }, (_, index) => [index, 0])
  const scene = {
    ...scene_example(hash, 0),
    elements: [
      { type: 'sketch', id: 'kept', strokes: ['shape:long'] },
      { type: 'stroke', id: 'mine', points: own },
    ],
  }
  expect(board.cleaned_publish(scene)).toMatchObject({ kind: 'invalid' })
  scene.elements[1] = { type: 'stroke', id: 'mine', points: own.slice(1) }
  expect(board.cleaned_publish(scene)).toMatchObject({ kind: 'published', revision: 1 })
  board.destroy()
})

test('a draft is the records its publish would save, and saves nothing', () => {
  const disk = sketch_disk([hill, sun])
  const board = board_open(disk)
  const hash = board.document_state().hash
  board.cleaned_publish(scene_example(hash, 0))
  const saved = disk.read('cleaned.state')
  const before = ink(board)
  const drafted = board.preview_create(picture(hash, 1))
  expect(drafted).toMatchObject({ kind: 'preview', base_revision: 1, snapshot: hash })
  expect(disk.read('cleaned.state')).toEqual(saved)
  expect(board.cleaned_status().revision).toBe(1)
  expect(ink(board)).toEqual(before)

  // A draft is refused exactly where its publish would be.
  expect(board.preview_create(picture(hash, 0))).toEqual({ kind: 'revision_conflict', revision: 1 })
  expect(board.preview_create(picture('0'.repeat(16), 1))).toMatchObject({ kind: 'sketch_changed' })
  const job = board.preview_job(null)

  if (drafted.kind !== 'preview') throw Error('the draft was refused')

  expect(job.id).toBe(drafted.preview)
  const published = board.cleaned_publish(picture(hash, 1))
  expect(published).toMatchObject({ kind: 'published', records_hash: drafted.records_hash })
  expect(board.cleaned_document().records).toEqual(job.records!)
  board.destroy()
})

test('a crash in the middle of a publish keeps the previous canvas, now and after restart', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const hash = board.document_state().hash
  board.cleaned_publish(scene_example(hash, 0, 'Kept'))
  const kept = JSON.stringify(board.cleaned_document())

  disk.write_fault_armed = true
  expect(() => board.cleaned_publish(scene_example(hash, 1, 'Lost'))).toThrow(SimulatedCrash)
  expect(JSON.stringify(board.cleaned_document())).toBe(kept)
  board.destroy()

  const restarted = board_open(disk)
  expect(restarted.cleaned_document().revision).toBe(1)
  expect(JSON.stringify(restarted.cleaned_document().records)).toContain('Kept')

  // The next publish continues from the revision that survived.
  const again = restarted.cleaned_publish(scene_example(hash, 1, 'Next'))
  expect(again).toMatchObject({ kind: 'published', revision: 2 })
  restarted.destroy()
})

test('both canvases survive a restart, and the sketch changing makes the canvas stale', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  board.cleaned_publish(scene_example(board.document_state().hash, 0))
  const published = board.cleaned_document()
  board.close()

  const restarted = board_open(disk)
  expect(restarted.cleaned_document()).toEqual(published)
  restarted.close()

  // The ink changes while the canvas stays as it was published.
  sketch_save(disk, [sketch_square('shape:a', 0), sketch_square('shape:b', 40)])
  const changed = board_open(disk)
  const status = changed.cleaned_status()
  expect(status.stale).toBe(true)
  expect(status.current?.source_hash).toBe(published.current?.source_hash)
  expect(status.sketch_hash).not.toBe(published.sketch_hash)
  expect(changed.cleaned_document().records).toEqual(published.records)
  changed.destroy()
})

function cleaned_forge(disk: SimulatedDisk, state: unknown): void {
  const payload = new TextEncoder().encode(JSON.stringify(state))
  disk.write_atomic('cleaned.state', envelope_encode({ kind: 'cleaned', label: '-', payload }))
}

const format = 'tldraw-sync.canvas.v3'
const box = { type: 'geo', id: 'a', x: 0, y: 0, w: 10, h: 10 }

function version_forged(revision: unknown, overrides: Json = {}) {
  return {
    revision,
    source_hash: '0123456789abcdef',
    agent: 'x',
    summary: '',
    published_at_ms: 0,
    restored_from: null,
    scene: [box],
    ...overrides,
  }
}

function state_forged(revision: unknown, current: unknown, history: unknown) {
  return { format, revision, current, history }
}

// A version saved as records, as a revision from a retired format is.
function recorded(revision: number, change: (records: Json[]) => void) {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  board.cleaned_publish(scene_example(board.document_state().hash, 0))
  const records = structuredClone(records_of(board))
  board.destroy()
  change(records)
  return version_forged(revision, { scene: undefined, records })
}

const image_record = { id: 'shape:img', typeName: 'shape', type: 'image', props: {} }
const link_text = {
  type: 'doc',
  content: [
    {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'x', marks: [{ type: 'link', attrs: { href: 'http://e.example' } }] },
      ],
    },
  ],
}

// Each of these has a valid checksum and is valid JSON. What is wrong is the shape of the
// root, a revision, current canvas and history that no publish or restore could have left, or
// a canvas that this board would never have published.
const states_damaged: Array<[string, unknown]> = [
  ['root null', null],
  ['root list', []],
  ['root number', 5],
  ['root text', 'cleaned'],
  ['root without fields', {}],
  ['an unknown format', { ...state_forged(0, null, []), format: 'tldraw-sync.canvas.v9' }],
  ['revision missing', { format, current: null, history: [] }],
  ['revision as text', state_forged('1', version_forged(1), [])],
  ['revision negative', state_forged(-1, null, [])],
  ['revision fractional', state_forged(1.5, version_forged(1.5), [])],
  ['nothing current at a later revision', state_forged(2, null, [])],
  ['nothing current but a history', state_forged(0, null, [version_forged(1)])],
  ['current missing', { format, revision: 0, history: [] }],
  ['current a list', state_forged(1, [], [])],
  ['current a number', state_forged(1, 1, [])],
  ['current at revision zero', state_forged(0, version_forged(0), [])],
  ['current behind the revision', state_forged(3, version_forged(2), [])],
  ['current ahead of the revision', state_forged(2, version_forged(3), [])],
  ['history missing', { format, revision: 0, current: null }],
  ['history an object', state_forged(1, version_forged(1), {})],
  ['history entry null', state_forged(2, version_forged(2), [null])],
  [
    'history over its bound',
    state_forged(
      cleaned_history_count_max + 2,
      version_forged(cleaned_history_count_max + 2),
      Array.from({ length: cleaned_history_count_max + 1 }, (_, index) =>
        version_forged(index + 1),
      ),
    ),
  ],
  [
    'history out of order',
    state_forged(3, version_forged(3), [version_forged(2), version_forged(1)]),
  ],
  [
    'history repeats a revision',
    state_forged(3, version_forged(3), [version_forged(1), version_forged(1)]),
  ],
  [
    'history reaches the current revision',
    state_forged(3, version_forged(3), [version_forged(1), version_forged(3)]),
  ],
  [
    'history newer than the current revision',
    state_forged(3, version_forged(3), [version_forged(4)]),
  ],
  ['restored from itself', state_forged(2, version_forged(2, { restored_from: 2 }), [])],
  ['restored from a later revision', state_forged(2, version_forged(2, { restored_from: 5 }), [])],
  ['restored from revision zero', state_forged(2, version_forged(2, { restored_from: 0 }), [])],
  ['restored from text', state_forged(2, version_forged(2, { restored_from: '1' }), [])],
  ['published at no time', state_forged(1, version_forged(1, { published_at_ms: 'now' }), [])],
  ['an agent name with markup', state_forged(1, version_forged(1, { agent: '<b>x</b>' }), [])],
  ['neither a scene nor records', state_forged(1, version_forged(1, { scene: undefined }), [])],
  ['both a scene and records', state_forged(1, version_forged(1, { records: [] }), [])],
  ['a scene that is not a list', state_forged(1, version_forged(1, { scene: {} }), [])],
  [
    'an element of a kind no scene has',
    state_forged(
      1,
      version_forged(1, { scene: [{ type: 'image', id: 'a', src: 'http://x' }] }),
      [],
    ),
  ],
  [
    'an element with a link',
    state_forged(1, version_forged(1, { scene: [{ ...box, url: 'http://e.example' }] }), []),
  ],
  [
    'a sketch element without the strokes it holds',
    state_forged(
      1,
      version_forged(1, {
        scene: [
          {
            type: 'sketch',
            id: 'p',
            strokes: ['shape:s'],
            x: 0,
            y: 0,
            w: 5,
            h: 5,
            source_hash: '1'.repeat(16),
          },
          box,
        ],
      }),
      [],
    ),
  ],
  [
    'records that are not a list',
    state_forged(1, version_forged(1, { scene: undefined, records: {} }), []),
  ],
  [
    'records with a kind of shape no canvas holds',
    state_forged(
      1,
      recorded(1, (records) => records.push(image_record)),
      [],
    ),
  ],
  [
    'records with a link',
    state_forged(
      1,
      recorded(1, (records) => (records[1]!.props.url = 'http://e.example')),
      [],
    ),
  ],
  [
    'records with a link in their words',
    state_forged(
      1,
      recorded(1, (records) => (records[1]!.props.richText = link_text)),
      [],
    ),
  ],
  [
    'a binding to a shape that is not there',
    state_forged(
      1,
      recorded(1, (records) => (records.at(-1)!.toId = 'shape:gone')),
      [],
    ),
  ],
  [
    'a shape inside a group that is not there',
    state_forged(
      1,
      recorded(1, (records) => (records[0]!.parentId = 'shape:gone')),
      [],
    ),
  ],
  [
    'two records with one id',
    state_forged(
      1,
      recorded(1, (records) => records.push(records[0]!)),
      [],
    ),
  ],
  [
    'a retired format with a shape that cannot be drawn',
    {
      format: 'tldraw-sync.cleaned.v1',
      revision: 1,
      history: [],
      current: version_forged(1, { scene: undefined, shapes: [{ kind: 'script', id: 'x' }] }),
    },
  ],
]

for (const [name, state] of states_damaged) {
  test(`a checksummed canvas file with ${name} stops the board with a storage error`, () => {
    const disk = sketch_disk([sketch_square('shape:a', 0)])
    cleaned_forge(disk, state)
    const saved = disk.read('cleaned.state')
    let thrown: unknown = null

    try {
      board_open(disk).destroy()
    } catch (error) {
      thrown = error
    }

    // A StorageError exactly: a TypeError or a failed assertion would be a crash, not a
    // refusal.
    expect(thrown).toBeInstanceOf(StorageError)
    expect((thrown as Error).message).toContain('cleaned.state is damaged')

    // Nothing was overwritten, so the file is still there to be repaired.
    expect(disk.read('cleaned.state')).toEqual(saved)
  })
}

test('a file with a flipped bit stops the board instead of dropping the canvas', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  board.cleaned_publish(scene_example(board.document_state().hash, 0))
  board.destroy()

  const saved = disk.read('cleaned.state') as Uint8Array
  const flipped = saved.slice()
  flipped[flipped.length - 3] = (flipped[flipped.length - 3] as number) ^ 1
  disk.write_atomic('cleaned.state', flipped)
  expect(() => board_open(disk)).toThrow(StorageError)
  expect(disk.read('cleaned.state')).toEqual(flipped)
})

test('a forged canvas file that is coherent opens, so each refusal is for its cause', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  cleaned_forge(
    disk,
    state_forged(3, version_forged(3, { restored_from: 1 }), [
      version_forged(1),
      recorded(2, () => undefined),
    ]),
  )
  const board = board_open(disk)
  const status = board.cleaned_status()
  expect(status.revision).toBe(3)
  expect(status.current).toMatchObject({ revision: 3, restored_from: 1, shapes_count: 1 })
  expect(status.history.map((version) => [version.revision, version.legacy])).toEqual([
    [1, false],
    [2, true],
  ])
  expect(board.cleaned_restore(3, 2)).toMatchObject({ kind: 'restored', revision: 4 })
  expect(board.cleaned_document().records).toHaveLength(6)
  board.destroy()

  // Nothing published is coherent too, and is where a first publish starts from.
  const fresh_disk = new SimulatedDisk()
  cleaned_forge(fresh_disk, state_forged(0, null, []))
  const empty = board_open(fresh_disk)
  expect(empty.cleaned_status()).toMatchObject({ revision: 0, current: null, history: [] })
  empty.destroy()
})

test('a restore brings back an earlier revision as a new one, guarded by the base revision', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const hash = board.document_state().hash
  board.cleaned_publish(scene_example(hash, 0, 'One'))
  board.cleaned_publish(scene_example(hash, 1, 'Two'))

  expect(board.cleaned_restore(1, null)).toEqual({ kind: 'revision_conflict', revision: 2 })
  expect(board.cleaned_restore(2, 7)).toEqual({ kind: 'not_found' })
  expect(board.cleaned_status().revision).toBe(2)

  const before = ink(board)
  expect(board.cleaned_restore(2, null)).toEqual({
    kind: 'restored',
    revision: 3,
    restored_from: 1,
  })
  expect(ink(board)).toEqual(before)
  const document = board.cleaned_document()
  expect(document.current).toMatchObject({ revision: 3, restored_from: 1 })
  expect(JSON.stringify(document.records)).toContain('One')

  // The restored scene is the one to edit next.
  expect(JSON.stringify(board.sketch_snapshot(hash)!.scene)).toContain('One')

  // Nothing was lost: the revision that was replaced can itself be restored.
  expect(document.history.map((version) => version.revision)).toEqual([1, 2])
  expect(board.cleaned_restore(3, 2)).toMatchObject({ kind: 'restored', revision: 4 })
  board.destroy()
})

test('history keeps only the most recent revisions', () => {
  const board = board_open(sketch_disk([sketch_square('shape:a', 0)]))
  const hash = board.document_state().hash
  const publishes_count = cleaned_history_count_max + 5

  for (let revision = 0; revision < publishes_count; revision += 1) {
    board.cleaned_publish(scene_example(hash, revision, `Title ${revision}`))
  }

  const { history, revision } = board.cleaned_status()
  expect(revision).toBe(publishes_count)
  expect(history).toHaveLength(cleaned_history_count_max)
  expect(history.at(-1)?.revision).toBe(publishes_count - 1)
  expect(board.cleaned_restore(revision, 1)).toEqual({ kind: 'not_found' })
  board.destroy()
})

// Random publishes of both kinds, drafts, conflicts, invalid scenes, restores, sketch changes,
// crashes during a write, and restarts. After every step, the board agrees with a model of
// what was committed, and a board reopened from the disk agrees with both.
test('a seeded run of canvas operations keeps every invariant', () => {
  const seed = Number(process.env.SEED ?? 3)
  const runs_count = process.env.SEED === undefined ? 20 : 1

  for (let run = 0; run < runs_count; run += 1) canvas_run(seed + run)
})

type Model = { revision: number; history_count: number; records: string }

function scene_random(prng: Prng, hash: string, model: Model, step: number): Json {
  const snapshot = prng.chance(0.8) ? hash : '0000000000000000'
  const base = prng.chance(0.8) ? model.revision : prng.below(model.revision + 2)
  const scene: Json = scene_example(snapshot, base, `Step ${step}`)

  if (prng.chance(0.3)) scene.basis = 'canvas'

  if (prng.chance(0.15)) scene.elements[1] = { ...scene.elements[1], w: -1 }

  return scene
}

function canvas_run(seed: number): void {
  const prng = new Prng(seed)
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  let board = board_open(disk)
  let model: Model = { revision: 0, history_count: 0, records: '[]' }
  const label = (step: number) => `seed ${seed} step ${step}`

  for (let step = 0; step < 60; step += 1) {
    const before = ink(board)
    const roll = prng.below(100)

    // Only a publish or a restore writes here, so only those meet an injected crash.
    const crash = roll < 60 && prng.chance(0.15)
    disk.write_fault_armed = crash
    let committed = false

    try {
      if (roll < 40) {
        const scene = scene_random(prng, before.hash, model, step)
        committed = board.cleaned_publish(scene).kind === 'published'
      } else if (roll < 60) {
        const base = prng.chance(0.8) ? model.revision : prng.below(model.revision + 2)
        committed = board.cleaned_restore(base, null).kind === 'restored'
      } else if (roll < 72) {

        // A draft writes nothing, whatever it holds: an armed fault is never met.
        disk.write_fault_armed = true
        board.preview_create(scene_random(prng, before.hash, model, step))
      } else if (roll < 86) {
        board.destroy()
        sketch_save(disk, [sketch_square('shape:a', prng.below(100))])
        board = board_open(disk)
      } else {
        board.close()
        board = board_open(disk)
      }
    } catch (error) {
      if (!(error instanceof SimulatedCrash)) throw error

      expect(crash, label(step)).toBe(true)
    }

    disk.write_fault_armed = false

    if (roll < 72) expect(ink(board), label(step)).toEqual(before)

    if (committed) {
      model = {
        revision: model.revision + 1,
        history_count: Math.min(
          cleaned_history_count_max,
          model.history_count + (model.revision > 0 ? 1 : 0),
        ),
        records: JSON.stringify(board.cleaned_document().records),
      }
    }

    canvas_check(board, model, label(step))
    const reopened = board_open(disk)
    expect(JSON.stringify(reopened.cleaned_document().records), label(step)).toBe(model.records)
    reopened.destroy()
  }

  board.destroy()
}

function canvas_check(board: Board, model: Model, label: string): void {
  const document = board.cleaned_document()
  expect(document.revision, label).toBe(model.revision)
  expect(document.history.length, label).toBe(model.history_count)
  expect(JSON.stringify(document.records), label).toBe(model.records)
  expect(document.current === null, label).toBe(model.revision === 0)
  const revisions = document.history.map((version) => version.revision)
  expect(revisions, label).toEqual([...revisions].sort((a, b) => a - b))
  expect(
    revisions.every((revision) => revision < model.revision),
    label,
  ).toBe(true)
}
