// Scenes with controls, through the production board on an injected disk: what a page that
// knows nothing of controls is shown, what a page that does can ask for, that every reference
// is checked before anything is written, that drafts of any view publish nothing, and that
// the controls survive a restart and a restore. A seeded run checks the projection rules on
// many views of generated scenes.

import { expect, test } from 'bun:test'
import { scene_controls_count_max } from '../shared/constants'
import { document_hash } from '../shared/document_hash'
import { view_state_read, view_state_rest } from '../shared/scene_controls'
import { scene_project } from '../shared/scene_view'
import { Prng } from '../simulation/prng'
import { SimulatedDisk } from '../simulation/simulated_disk'
import {
  scene_controlled,
  scene_example,
  sketch_disk,
  sketch_square,
} from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import { Board, StorageError } from './board'
import { canvas_records_problem } from './canvas_records'
import { state_decode } from './canvas_state'
import { scene_parse } from './scene_proposal'
import { view_records } from './scene_view_records'
import { envelope_encode } from './storage'

type Json = Record<string, any>

const board_open = (disk: SimulatedDisk) => Board.open({ time: new VirtualTime(), disk })
const ids = (records: ReadonlyArray<{ id: string }>) => records.map((record) => record.id).sort()

function view_of(board: Board, state: unknown) {
  const result = board.cleaned_view(state)

  if (result.kind !== 'view') throw new Error(`${result.path}: ${result.message}`)

  return result.view
}

function saved(disk: SimulatedDisk): Json {
  const bytes = disk.read('cleaned.state')
  expect(bytes).not.toBeNull()
  return state_decode(bytes!)
}

test('a scene without controls is published, saved and shown exactly as before', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const scene = scene_example(board.document_state().hash, 0)
  const drafted = board.preview_create(scene)
  const published = board.cleaned_publish(scene)
  expect(published).toMatchObject({ kind: 'published', revision: 1 })
  expect(drafted).toMatchObject({ kind: 'preview', state: {}, states_count: 1 })
  expect((drafted as Json).records_hash).toBe((published as Json).records_hash)

  // Nothing about controls is saved for a scene that has none.
  const version = saved(disk).current
  expect(version).not.toHaveProperty('controls')
  expect(JSON.stringify(version.scene)).not.toMatch(/visible_when|on_tap/)

  // A page that asks for a view of it gets the one view there is.
  const view = view_of(board, null)
  expect(view).toMatchObject({ revision: 1, controls: [], state: {}, states_count: 1, taps: [] })
  expect(view.records).toEqual(board.cleaned_document().records)
  expect(board.cleaned_view({ season: 'winter' })).toMatchObject({
    kind: 'invalid',
    path: 'state.season',
  })
  board.destroy()
})

test('a scene with controls shows every page its view at rest, and any view on request', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const scene = scene_controlled(board.document_state().hash, 0)
  const published = board.cleaned_publish(scene)
  expect(published).toMatchObject({ kind: 'published', revision: 1, shapes_count: 4 })

  // An old page reads the records at rest: the group of one is dissolved, its caption lifted.
  const document = board.cleaned_document()
  expect(ids(document.records)).toEqual([
    'binding:scene-shine-end',
    'binding:scene-shine-start',
    'shape:scene-caption',
    'shape:scene-house',
    'shape:scene-shine',
    'shape:scene-sun',
  ])
  const caption = document.records.find((record) => record.id === 'shape:scene-caption') as Json
  expect(caption).toMatchObject({ parentId: 'page:page', x: 0, y: 180 })
  expect(canvas_records_problem(document.records)).toBeNull()

  const rest = view_of(board, null)
  expect(rest.records).toEqual(document.records)
  expect(rest.state).toEqual({ season: 'summer', stage: 'plan', labels: 'off' })
  expect(rest.states_count).toBe(12)
  expect(rest.controls.map((control) => control.id)).toEqual(['season', 'stage', 'labels'])
  expect(rest.controls[2]).toEqual({ id: 'labels', kind: 'toggle', label: 'Labels' })
  expect(rest.taps).toEqual([{ shape_id: 'shape:scene-sun', control: 'season', value: 'winter' }])

  // Winter with labels: the snow, no arrow, and the group back with both of its texts.
  const winter = view_of(board, { season: 'winter', labels: 'on' })
  expect(winter.state).toEqual({ season: 'winter', stage: 'plan', labels: 'on' })
  expect(ids(winter.records)).toEqual([
    'shape:scene-caption',
    'shape:scene-house',
    'shape:scene-note',
    'shape:scene-snow',
    'shape:scene-tags',
  ])
  const grouped = winter.records.find((record) => record.id === 'shape:scene-caption') as Json
  expect(grouped.parentId).toBe('shape:scene-tags')
  expect(canvas_records_problem(winter.records)).toBeNull()
  expect(winter.taps).toEqual([
    { shape_id: 'shape:scene-snow', control: 'season', value: 'summer' },
  ])

  // A shape has the same id and index in every view it is shown in.
  const house = (records: ReadonlyArray<{ id: string }>) =>
    records.find((record) => record.id === 'shape:scene-house') as Json
  expect(house(winter.records)).toEqual(house(rest.records))

  // Asking for views changed nothing.
  expect(board.cleaned_status().revision).toBe(1)
  expect(board.cleaned_document().records).toEqual(document.records)
  board.destroy()
})

test('every reference to a control is checked, and a bad one is refused before any write', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const hash = board.document_state().hash
  const cases: Array<[string, (scene: Json) => void]> = [
    ['elements[1].visible_when[0].control', (s) => (s.elements[1].visible_when[0].control = 'x')],
    ['elements[1].visible_when[0]', (s) => (s.elements[1].visible_when[0].values = ['autumn'])],
    ['elements[1].visible_when', (s) => (s.elements[1].visible_when = [])],
    ['elements[1].on_tap', (s) => (s.elements[1].on_tap.value = 'spring')],
    ['elements[1].on_tap.control', (s) => (s.elements[1].on_tap.control = 'weather')],
    ['elements[6].on_tap', (s) => (s.elements[6].on_tap = { control: 'labels', value: 'on' })],
    ['elements[1].visible_when[0].values', (s) => (s.elements[1].visible_when[0].values = [])],
    ['proposal.controls', (s) => (s.controls[1].id = 'season')],
    ['controls[0].id', (s) => (s.controls[0].id = '__proto__')],
    ['controls[0].options', (s) => (s.controls[0].options = s.controls[0].options.slice(0, 1))],
    ['controls[0].options', (s) => (s.controls[0].options[1].value = 'summer')],
    ['controls[2].options', (s) => (s.controls[2].options = [])],
    ['controls[1].kind', (s) => (s.controls[1].kind = 'slider')],
    ['controls[0].label', (s) => (s.controls[0].label = 'two\nlines')],
    ['controls[0].script', (s) => (s.controls[0].script = 'alert(1)')],
    [
      'elements[1].visible_when[0].expression',
      (s) => (s.elements[1].visible_when[0].expression = '1'),
    ],
    ['elements[1].visible_when[0].control', (s) => delete s.controls],
    [
      'elements[1].visible_when',
      (s) => s.elements[1].visible_when.push({ control: 'season', values: ['winter'] }),
    ],
    [
      'proposal.controls',
      (s) =>
        (s.controls = Array.from({ length: scene_controls_count_max + 1 }, (_, i) => ({
          id: `c${i}`,
          kind: 'toggle',
          label: 'C',
        }))),
    ],
  ]

  for (const [path, damage] of cases) {
    const scene: Json = structuredClone(scene_controlled(hash, 0))
    damage(scene)
    const refused = { kind: 'invalid', path }
    expect([path, board.preview_create(scene)]).toMatchObject([path, refused])
    expect([path, board.cleaned_publish(scene)]).toMatchObject([path, refused])
  }

  expect(disk.read('cleaned.state')).toBeNull()
  expect(board.cleaned_status().revision).toBe(0)
  board.destroy()
})

test('a draft of any view publishes nothing; the draft at rest is what the publish saves', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  const hash = board.document_state().hash
  board.cleaned_publish(scene_example(hash, 0))
  const before = disk.read('cleaned.state')
  const document = board.cleaned_document()
  const scene = scene_controlled(hash, 1)

  const winter = board.preview_create(scene, { season: 'winter', stage: 'ship' })
  expect(winter).toMatchObject({
    kind: 'preview',
    state: { season: 'winter', stage: 'ship', labels: 'off' },
    states_count: 12,
    shapes_count: 4,
  })
  const rest = board.preview_create(scene)
  expect(rest).toMatchObject({ kind: 'preview', state: { season: 'summer' } })
  expect((winter as Json).records_hash).not.toBe((rest as Json).records_hash)

  // A view state that names something the scene lacks is refused like any bad scene.
  expect(board.preview_create(scene, { weather: 'rain' })).toMatchObject({
    kind: 'invalid',
    path: 'state.weather',
  })
  expect(board.preview_create(scene, { season: 'spring' })).toMatchObject({ kind: 'invalid' })
  expect(board.preview_create(scene, ['winter'])).toMatchObject({ kind: 'invalid', path: 'state' })

  expect(disk.read('cleaned.state')).toEqual(before)
  expect(board.cleaned_document()).toEqual(document)
  const published = board.cleaned_publish(scene)
  expect(published).toMatchObject({ kind: 'published', revision: 2 })
  expect((published as Json).records_hash).toBe((rest as Json).records_hash)
  board.destroy()
})

test('controls survive a restart and a restore, and are offered back to the agent', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  let board = board_open(disk)
  const hash = board.document_state().hash
  board.cleaned_publish(scene_controlled(hash, 0))
  const first = view_of(board, { season: 'winter', labels: 'on' })
  board.cleaned_publish(scene_example(hash, 1))
  board.destroy()

  board = board_open(disk)
  expect(view_of(board, null)).toMatchObject({ revision: 2, controls: [], states_count: 1 })
  expect(board.cleaned_restore(2, 1)).toMatchObject({ kind: 'restored', revision: 3 })
  const restored = view_of(board, { season: 'winter', labels: 'on' })
  expect(restored.records).toEqual(first.records)
  expect(restored.controls).toEqual(first.controls)
  board.destroy()

  // After another restart the agent is offered the scene and its controls, which read again
  // as the same proposal, ready to edit.
  board = board_open(disk)
  const snapshot = board.sketch_snapshot(hash)!
  expect(snapshot.scene_controls).toEqual(first.controls)
  const again = scene_parse({
    ...scene_controlled(hash, 3),
    controls: snapshot.scene_controls,
    elements: snapshot.scene,
  })
  const original = scene_parse(scene_controlled(hash, 3))
  expect(again.ok && original.ok).toBe(true)
  expect(again).toEqual(original)
  expect(document_hash(view_of(board, { season: 'winter', labels: 'on' }).records)).toBe(
    document_hash(first.records),
  )
  board.destroy()
})

test('a saved revision whose references do not hold stops the start, and the file stays', () => {
  const disk = sketch_disk([sketch_square('shape:a', 0)])
  const board = board_open(disk)
  board.cleaned_publish(scene_controlled(board.document_state().hash, 0))
  board.destroy()
  const state = saved(disk)
  const damages: Array<(version: Json) => void> = [
    (version) => (version.controls[0].options[1].value = 'autumn'),
    (version) => delete version.controls,
    (version) => (version.scene[1].visible_when[0].control = 'weather'),
  ]

  for (const damage of damages) {
    const broken = structuredClone(state)
    damage(broken.current)
    const payload = new TextEncoder().encode(JSON.stringify(broken))
    const bytes = envelope_encode({ kind: 'cleaned', label: '-', payload })
    disk.write_atomic('cleaned.state', bytes)
    expect(() => board_open(disk)).toThrow(StorageError)
    expect(disk.read('cleaned.state')).toEqual(bytes)
  }
})

// The rules of a view, on generated scenes and states: a view is valid tldraw records, part
// of the scene, with no binding to a hidden shape, no group of fewer than two, and the same
// record for a shape in every view that shows it.
test('every view of a generated scene is a valid part of it', () => {
  const seeds_count = 64
  const states_per_scene = 8

  for (let seed = 1; seed <= seeds_count; seed += 1) {
    const prng = new Prng(seed)
    const input = scene_generated(prng)
    const parsed = scene_parse(input)

    if (!parsed.ok) throw new Error(`seed ${seed}: ${parsed.path}: ${parsed.message}`)

    const { controls, elements } = parsed.proposal
    const union = new Map<string, string>()

    for (let index = 0; index < states_per_scene; index += 1) {
      const wanted = Object.fromEntries(
        controls.map((control) => [control.id, pick(prng, control.options).value]),
      )
      const read = view_state_read(controls, index === 0 ? null : wanted)
      expect(read.ok).toBe(true)
      const state = read.ok ? read.state : view_state_rest(controls)
      const records = view_records(elements, state)
      expect([seed, canvas_records_problem(records)]).toEqual([seed, null])
      view_invariants_check(seed, records as unknown as Json[], union)
      expect(scene_project(elements, state).elements.length).toBeLessThanOrEqual(elements.length)
    }
  }
})

function view_invariants_check(seed: number, records: Json[], union: Map<string, string>) {
  const shapes = new Map(records.filter((r) => r.typeName === 'shape').map((r) => [r.id, r]))

  for (const record of records) {
    if (record.typeName === 'binding') {
      expect([seed, shapes.has(record.toId) && shapes.has(record.fromId)]).toEqual([seed, true])
      continue
    }

    if (record.type === 'group') {
      const held = records.filter((other) => other.parentId === record.id).length
      expect([seed, held >= 2]).toEqual([seed, true])
    }

    // A leaf shape is the same record wherever it is shown, unless its group changed.
    const key = JSON.stringify({ ...record, parentId: null, x: null, y: null })
    expect([seed, union.get(record.id) ?? key]).toEqual([seed, key])
    union.set(record.id, key)
  }
}

function pick<T>(prng: Prng, items: readonly T[]): T {
  const item = items[prng.below(items.length)]
  expect(item).toBeDefined()
  return item as T
}

// A scene of a few shapes, arrows between them and groups around them, some nested, each shown
// under a random condition on a few random controls.
function scene_generated(prng: Prng): Json {
  const controls = Array.from({ length: prng.between(1, 3) }, (_, index) => {
    const kind = pick(prng, ['choice', 'steps', 'toggle'])
    const values = ['a', 'b', 'c'].slice(0, prng.between(2, 3))
    const options = values.map((value) => ({ value, label: value.toUpperCase() }))
    return kind === 'toggle'
      ? { id: `k${index}`, kind, label: 'K', values: ['off', 'on'] }
      : { id: `k${index}`, kind, label: 'K', options, values }
  })
  const condition = () => {
    const control = pick(prng, controls)
    const values = control.values.filter(() => prng.chance(0.5))
    return values.length === 0 ? undefined : [{ control: control.id, values }]
  }
  const elements: Json[] = []
  const groups_count = prng.between(0, 2)

  for (let index = 0; index < 8; index += 1) {
    const shape: Json = { type: 'geo', id: `s${index}`, x: index * 50, y: index * 9, w: 30, h: 30 }
    const shown = prng.chance(0.5) ? condition() : undefined

    if (index < groups_count * 3) shape.parent = `g${Math.floor(index / 3)}`

    if (shown !== undefined) shape.visible_when = shown

    elements.push(shape)
  }

  for (let index = 0; index < groups_count; index += 1) {
    const group: Json = { type: 'group', id: `g${index}` }
    const shown = prng.chance(0.3) ? condition() : undefined

    if (index === 1 && prng.chance(0.5)) group.parent = 'g0'

    if (shown !== undefined) group.visible_when = shown

    elements.push(group)
  }

  for (let index = 0; index < 3; index += 1) {
    const ends = { from: `s${prng.between(0, 3)}`, to: `s${prng.between(4, 7)}` }
    elements.push({ type: 'arrow', id: `a${index}`, ...ends })
  }

  const written = controls.map(({ values: _values, ...control }) => control)
  return { ...scene_example('0123456789abcdef', 0), controls: written, elements }
}
