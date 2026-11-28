// The page's own projection of an interactive revision, against the board's: through the
// production board on an injected disk and the real view route. Every view the page projects
// from the scene it is served is the view the board serves; the scene holds only what the
// publish saved; a static or damaged scene leaves the page at rest; and the modules the page
// projects with reach nothing a browser lacks.

import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Board } from '../server/board'
import { cleaned_view_response } from '../server/http_canvas'
import { board_default_id } from '../shared/board_session'
import { interactive_scene_format } from '../shared/canvas_types'
import { interactive_view_size_bytes_max } from '../shared/constants'
import { document_hash } from '../shared/document_hash'
import { scene_format } from '../shared/scene_types'
import { Prng } from '../simulation/prng'
import {
  scene_controlled,
  scene_example,
  sketch_disk,
  sketch_square,
  sketch_stroke,
} from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import {
  interactive_scene_read,
  interactive_view,
  scene_envelope,
  view_state_key,
  view_state_same,
  view_state_with,
  type LocalScene,
  type SceneRefusal,
} from './interactive_scene'

type Json = Record<string, any>

const view_url = 'http://board.test/api/cleaned/view.json'
const secret_sample = 123.456

const board_open = () => {
  const disk = sketch_disk([
    sketch_square('shape:box', 0),
    sketch_stroke('shape:loop', 40, 300, [
      [0, 0],
      [30, 20],
      [60, 0],
    ]),
    sketch_stroke('shape:secret', 900, 900, [
      [0, 0],
      [secret_sample, 7],
    ]),
  ])
  return Board.open({ time: new VirtualTime(), disk })
}

const when = (control: string, ...values: string[]) => [{ control, values }]
const option = (value: string, label: string) => ({ value, label })

const gateway_controls = [
  {
    id: 'answer',
    kind: 'choice',
    label: 'Gateway answers',
    options: [
      option('approved', 'Approved'),
      option('declined', 'Declined'),
      option('timeout', 'Times out'),
    ],
  },
  {
    id: 'attempt',
    kind: 'steps',
    label: 'Attempt',
    options: [option('first', 'First'), option('second', 'Second')],
  },
  { id: 'notes', kind: 'toggle', label: 'Notes' },
]

// An element shown only when `shown` holds, placed and worded.
function shown_when(element: Json, shown: Json[] | null): Json {
  return shown === null ? element : { ...element, visible_when: shown }
}

function text(id: string, y: number, words: string, shown: Json[] | null): Json {
  return shown_when({ type: 'text', id, x: 0, y, text: words }, shown)
}

function card(id: string, at: [number, number, number, number], words: string, shown: Json[]) {
  const [x, y, w, h] = at
  return shown_when({ type: 'geo', id, x, y, w, h, text: words }, shown)
}

// A gateway's three answers on one timeline: a headline for each, an outcome group that holds
// two shapes and an arrow for one answer, one shape for another and nothing for the third, a
// dashed hint whose tap picks an answer, a step and a toggle, and one copied pen stroke.
function scene_gateway(snapshot: string, base_revision: number): Json {
  const approved = when('answer', 'approved')
  const timeout = when('answer', 'timeout')
  const grouped = (element: Json) => ({ ...element, parent: 'outcome' })
  const elements = [
    text('ok', -60, 'Approved: placed in 3 s', approved),
    text('no', -60, 'Declined: the card is refused', when('answer', 'declined')),
    text('wait', -60, 'Times out: retry, then hold', timeout),
    {
      type: 'path',
      id: 'axis',
      points: [
        [0, 40],
        [600, 40],
      ],
    },
    grouped(card('placed', [0, 120, 200, 60], 'Order placed', approved)),
    grouped(card('receipt', [260, 120, 200, 60], 'Receipt emailed', approved)),
    grouped({ type: 'arrow', id: 'sends', from: 'placed', to: 'receipt' }),
    grouped(card('hold', [0, 120, 300, 60], 'Hold the order', timeout)),
    { type: 'group', id: 'outcome' },
    {
      ...card('hint', [300, 0, 180, 36], 'No answer by 30 s?', approved),
      dash: 'dashed',
      on_tap: { control: 'answer', value: 'timeout' },
    },
    card('again', [0, 200, 160, 40], 'Retry once', [...when('attempt', 'second'), ...timeout]),
    text('note', 260, 'The gateway gives up at 60 s', when('notes', 'on')),
    { type: 'sketch', id: 'loop', strokes: ['shape:loop'] },
  ]
  return {
    format: scene_format,
    session: board_default_id,
    snapshot,
    base_revision,
    agent: 'test-agent',
    summary: 'What happens for each answer of the gateway.',
    controls: gateway_controls,
    elements,
  }
}

function served(board: Board, query: string): { status: number; text: Promise<string> } {
  const response = cleaned_view_response(board, new URL(`${view_url}${query}`))
  return { status: response.status, text: response.text() }
}

async function scene_served(board: Board, revision: number): Promise<LocalScene> {
  const response = served(board, '?interactive=1')
  expect(response.status).toBe(200)
  const read = interactive_scene_read(await response.text, revision)

  if (!read.ok) throw new Error(`the served scene was refused: ${read.reason}`)

  return read.scene
}

function board_view(board: Board, state: Json) {
  const result = board.cleaned_view(state)

  if (result.kind !== 'view') throw new Error(`${result.path}: ${result.message}`)

  return result.view
}

test('every view the page projects is the view the board serves', async () => {
  const board = board_open()
  const published = board.cleaned_publish(scene_gateway(board.document_state().hash, 0))
  expect(published).toMatchObject({ kind: 'published', revision: 1 })
  expect(board.cleaned_document().current).toMatchObject({ interactive: true, legacy: false })
  const scene = await scene_served(board, 1)
  expect(scene.states_count).toBe(12)

  // The test lists the views; the page only ever projects the one chosen.
  for (const answer of ['approved', 'declined', 'timeout']) {
    for (const attempt of ['first', 'second']) {
      for (const notes of ['off', 'on']) {
        const state = { answer, attempt, notes }
        const local = interactive_view(scene, state)
        const remote = board_view(board, state)
        expect([state, document_hash(local.records)]).toEqual([
          state,
          document_hash(remote.records),
        ])
        expect(local.records).toEqual(remote.records)
        expect(local.taps).toEqual(remote.taps)
      }
    }
  }

  // At rest the page's view is the records every page is served.
  expect(interactive_view(scene, scene.rest).records).toEqual(board.cleaned_document().records)
  expect(board.cleaned_status().revision).toBe(1)
  board.destroy()
})

test('a group a view leaves holding one shape is dissolved, and an empty one is gone', async () => {
  const board = board_open()
  board.cleaned_publish(scene_gateway(board.document_state().hash, 0))
  const scene = await scene_served(board, 1)
  const ids = (state: Json) => interactive_view(scene, state).records.map((record) => record.id)
  const record = (state: Json, id: string) =>
    interactive_view(scene, state).records.find((candidate) => candidate.id === id) as Json

  // Approved: the group holds both cards and the arrow between them.
  const approved = { answer: 'approved', attempt: 'first', notes: 'off' }
  expect(ids(approved)).toContain('shape:scene-outcome')
  expect(record(approved, 'shape:scene-placed').parentId).toBe('shape:scene-outcome')
  expect(ids(approved)).toContain('binding:scene-sends-end')

  // Times out: the group would hold one card, so the card is lifted to the page where it was.
  const timeout = { ...approved, answer: 'timeout' }
  expect(ids(timeout)).not.toContain('shape:scene-outcome')
  expect(record(timeout, 'shape:scene-hold')).toMatchObject({ parentId: 'page:page', x: 0 })
  expect(ids(timeout)).not.toContain('shape:scene-sends')

  // Declined: nothing is left of the group, and no binding names a hidden shape.
  const declined = { ...approved, answer: 'declined' }
  expect(ids(declined).filter((id) => id.includes('outcome') || id.includes('sends'))).toEqual([])

  // The copied stroke is in every view, unchanged.
  for (const state of [approved, timeout, declined]) {
    expect(record(state, 'shape:scene-loop.0')).toEqual(record(approved, 'shape:scene-loop.0'))
  }

  // The hint's tap is offered only in the view that shows it.
  expect(interactive_view(scene, approved).taps).toEqual([
    { shape_id: 'shape:scene-hint', control: 'answer', value: 'timeout' },
  ])
  expect(interactive_view(scene, timeout).taps).toEqual([])
  board.destroy()
})

test('the scene holds the publish and its copied stroke, nothing else of the sketch', async () => {
  const board = board_open()
  board.cleaned_publish(scene_gateway(board.document_state().hash, 0))
  const body = JSON.parse(await served(board, '?interactive=1').text) as Json
  const scene = body.interactive as Json
  expect(Object.keys(scene).sort()).toEqual(['controls', 'elements', 'format', 'revision'])
  expect(scene).toMatchObject({ format: interactive_scene_format, revision: 1 })

  const text = JSON.stringify(scene)
  expect(text).not.toContain('shape:secret')
  expect(text).not.toContain('shape:box')
  expect(text).not.toContain(String(secret_sample))
  expect(text).not.toMatch(/token|machine_key|pair=|binding\.json/i)
  const sketch = (scene.elements as Json[]).find((element) => element.type === 'sketch')!
  expect(sketch.strokes).toEqual(['shape:loop'])
  expect(sketch.ink).toHaveLength(1)

  // The whole body adds only the scene to the view a page is served without asking.
  const plain = JSON.parse(await served(board, '').text) as Json
  expect(plain).not.toHaveProperty('interactive')
  const { interactive: _scene, ...rest } = body
  expect(rest).toEqual(plain)
  expect(served(board, '?interactive=yes').status).toBe(400)
  board.destroy()
})

test('a static revision costs no scene, and the page shows it at rest', async () => {
  const board = board_open()
  const hash = board.document_state().hash
  board.cleaned_publish(scene_example(hash, 0))
  expect(board.cleaned_document().current).toMatchObject({ interactive: false })
  const body = await served(board, '?interactive=1').text
  expect(JSON.parse(body).interactive).toBeNull()
  expect(interactive_scene_read(body, 1)).toEqual({ ok: false, reason: 'format' })

  // Controls that hide nothing give one view: the revision is not interactive.
  const hiding_nothing = scene_controlled(hash, 1)
  hiding_nothing.elements = hiding_nothing.elements.map(({ visible_when: _v, ...element }) => {
    return element
  })
  hiding_nothing.elements = hiding_nothing.elements.filter((element) => element.id !== 'snow')
  expect(board.cleaned_publish(hiding_nothing)).toMatchObject({ kind: 'published', revision: 2 })
  expect(board.cleaned_document().current).toMatchObject({ interactive: false })
  expect(JSON.parse(await served(board, '?interactive=1').text).interactive).toBeNull()
  board.destroy()
})

test('a scene of another format, revision, size or shape is refused whole', async () => {
  const board = board_open()
  board.cleaned_publish(scene_gateway(board.document_state().hash, 0))
  const good = await served(board, '?interactive=1').text
  const edited = (change: (body: Json) => void) => {
    const body = JSON.parse(good) as Json
    change(body)
    return JSON.stringify(body)
  }

  expect(interactive_scene_read(good, 1).ok).toBe(true)
  expect(interactive_scene_read(good, 2)).toEqual({ ok: false, reason: 'revision' })
  expect(interactive_scene_read('{', 1)).toEqual({ ok: false, reason: 'not_json' })
  const cases: Array<[SceneRefusal, (body: Json) => void]> = [
    ['format', (body) => (body.interactive.format = 'tldraw-sync.interactive.v2')],
    ['format', (body) => delete body.interactive],
    ['revision', (body) => (body.interactive.revision = 2)],
    ['revision', (body) => (body.revision = 2)],
    ['invalid', (body) => (body.interactive.controls = [])],
    ['invalid', (body) => (body.interactive.elements[0].token = 'secret')],
    ['invalid', (body) => (body.interactive.elements[0].visible_when[0].control = 'weather')],
    ['invalid', (body) => (body.interactive.elements[12].ink = [])],
    [
      'invalid',
      (body) =>
        (body.interactive.elements = body.interactive.elements.concat(
          Array.from({ length: 801 }, (_, index) => ({
            type: 'text',
            id: `x${index}`,
            x: 0,
            y: 0,
            text: 'x',
          })),
        )),
    ],
  ]

  for (const [reason, change] of cases) {
    expect([reason, interactive_scene_read(edited(change), 1)]).toEqual([
      reason,
      { ok: false, reason },
    ])
  }

  const padded = good.replace(/}$/, `,"pad":"${'x'.repeat(interactive_view_size_bytes_max)}"}`)
  expect(interactive_scene_read(padded, 1)).toEqual({ ok: false, reason: 'too_large' })
  board.destroy()
})

test('a choice names a value of the scene, and only such a choice becomes a view', async () => {
  const board = board_open()
  board.cleaned_publish(scene_gateway(board.document_state().hash, 0))
  const scene = await scene_served(board, 1)
  const rest = scene.rest
  expect(rest).toEqual({ answer: 'approved', attempt: 'first', notes: 'off' })
  expect(view_state_key(scene, rest)).toBe('approved/first/off')

  const timeout = view_state_with(scene, rest, 'answer', 'timeout')
  expect(timeout).toEqual({ ...rest, answer: 'timeout' })
  expect(view_state_same(timeout!, rest)).toBe(false)
  expect(view_state_same(view_state_with(scene, timeout!, 'answer', 'approved')!, rest)).toBe(true)
  expect(view_state_with(scene, rest, 'answer', 'maybe')).toBeNull()
  expect(view_state_with(scene, rest, 'weather', 'rain')).toBeNull()
  expect(view_state_with(scene, rest, '__proto__', 'x')).toBeNull()

  // The switch rests on the scene's top edge whichever view is shown.
  expect(scene_envelope(scene.elements)).toMatchObject({ x: 0, y: -60 })
  board.destroy()
})

// Generated scenes with nested groups, arrows and random conditions, seeded: the page and the
// board agree on views neither was written for.
test('the page and the board agree on every view of generated scenes', async () => {
  const seeds_count = 24

  for (let seed = 1; seed <= seeds_count; seed += 1) {
    const prng = new Prng(seed)
    const board = board_open()
    const input = scene_generated(prng, board.document_state().hash)
    const published = board.cleaned_publish(input)

    if (published.kind !== 'published')
      throw new Error(`seed ${seed}: ${JSON.stringify(published)}`)

    if (board.cleaned_document().current?.interactive !== true) {
      board.destroy()
      continue
    }

    const scene = await scene_served(board, 1)

    for (let index = 0; index < 6; index += 1) {
      const state = Object.fromEntries(
        scene.controls.map((control) => [
          control.id,
          control.options[prng.below(control.options.length)]!.value,
        ]),
      )
      const local = document_hash(interactive_view(scene, state).records)
      expect([seed, state, local]).toEqual([
        seed,
        state,
        document_hash(board_view(board, state).records),
      ])
    }

    board.destroy()
  }
})

function scene_generated(prng: Prng, snapshot: string): Json {
  const controls = Array.from({ length: prng.between(1, 3) }, (_, index) => ({
    id: `k${index}`,
    kind: 'choice',
    label: `K${index}`,
    options: ['a', 'b', 'c'].map((value) => ({ value, label: value.toUpperCase() })),
  }))
  const condition = () => {
    const control = controls[prng.below(controls.length)]!
    const values = ['a', 'b', 'c'].filter(() => prng.chance(0.5))
    return values.length === 0 ? [] : [{ control: control.id, values }]
  }
  const elements: Json[] = []

  for (let index = 0; index < 9; index += 1) {
    const shape: Json = { type: 'geo', id: `s${index}`, x: index * 50, y: index * 9, w: 30, h: 30 }
    const shown = prng.chance(0.6) ? condition() : []

    if (shown.length > 0) shape.visible_when = shown

    if (index < 6) shape.parent = index < 3 ? 'g0' : 'g1'

    elements.push(shape)
  }

  const inner: Json = { type: 'group', id: 'g0', parent: 'g1' }
  const inner_shown = condition()

  if (inner_shown.length > 0) inner.visible_when = inner_shown

  elements.push(inner)
  elements.push({ type: 'group', id: 'g1' })
  elements.push({ type: 'arrow', id: 'a0', from: 's1', to: 's7' })
  elements.push({ type: 'arrow', id: 'a1', from: 's4', to: 's8', parent: 'g1' })
  return { ...scene_example(snapshot, 0), controls, elements }
}

// The modules the page projects with, or reads a native board's views with, and every module
// they import, reach only this repository's pure modules and tldraw's schema: nothing of Node,
// Bun, the disk or the network.
const page_readers = [
  [
    'interactive_scene.ts',
    ['server/scene_view_records.ts', 'server/scene_proposal.ts'],
    ['@tldraw/tlschema'],
  ],
  ['native_views.ts', ['server/scene_control_reader.ts'], []],
] as const

for (const [start, reaching, packages] of page_readers) {
  test(`${start}, as the page runs it, reaches nothing a browser lacks`, () => {
    page_reader_check(start, reaching, packages)
  })
}

function page_reader_check(
  start: string,
  reaching: readonly string[],
  packages: readonly string[],
): void {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const root = path.resolve(here, '..')
  const reached = imports_walk(path.join(here, start))
  const files = [...reached.files].map((file) => path.relative(root, file)).sort()

  for (const file of reaching) expect(files).toContain(file)

  expect(
    files.every(
      (file) =>
        file.startsWith('shared/') || file.startsWith('server/') || file.startsWith('client/'),
    ),
  ).toBe(true)
  expect(
    files.filter(
      (file) =>
        /storage|board|http|disk|server_run/.test(file) && file !== 'shared/board_session.ts',
    ),
  ).toEqual([])
  expect([...reached.packages].sort()).toEqual([...packages])

  for (const file of reached.files) {
    const source = fs.readFileSync(file, 'utf8')
    expect([file, /\bBun\.|\bprocess\.|\bBuffer\b|\brequire\(|node:/.test(source)]).toEqual([
      file,
      false,
    ])
  }
}

function imports_walk(start: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>()
  const packages = new Set<string>()
  const pending = [start]
  const files_count_max = 64

  while (pending.length > 0) {
    const file = pending.pop()!

    if (files.has(file)) continue

    files.add(file)
    expect(files.size).toBeLessThanOrEqual(files_count_max)
    const source = fs.readFileSync(file, 'utf8')

    for (const match of source.matchAll(/from '([^']+)'/g)) {
      const specifier = match[1]!

      if (!specifier.startsWith('.')) {
        packages.add(specifier)
        continue
      }

      pending.push(path.resolve(path.dirname(file), `${specifier}.ts`))
    }
  }

  return { files, packages }
}
