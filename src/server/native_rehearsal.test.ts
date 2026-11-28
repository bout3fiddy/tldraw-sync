// A native rehearsal on real folders: a linked legacy board made by the board's own code, then
// rehearsed. The verdicts are the folders themselves, byte for byte, and the copy as the server
// opens it. Every refusal is checked to leave the source exactly as it was and no output, not
// even a partial one, behind.

import { afterEach, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shape_view_read, shape_view_shown, views_controls_read } from '../client/native_views'
import { time_real } from '../shared/time'
import {
  legacy_board_write,
  rehearsal_owner,
  sketch_strokes,
  type CanvasKind,
  type ChatKind,
} from '../../tests/fixtures/native-rehearsal/legacy_board'
import { BoardRegistry } from './board_registry'
import { index_key } from './canvas_records'
import { native_rehearse, type RehearsalResult } from './native_rehearsal'
import { room_plan } from './native_rehearsal_plan'
import { disk_open, envelope_decode, envelope_encode, session_storage } from './storage'
import { scoped_key } from './whiteboard_keys'

type Json = Record<string, any>

const folders: string[] = []
const entries_count_max = 256
const epoch = 'abcdef0123456789'

afterEach(() => {
  for (const folder of folders.splice(0)) {
    fs.chmodSync(folder, 0o700)
    fs.rmSync(folder, { recursive: true, force: true })
  }
})

function folder_create(): string {
  const folder = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-rehearse-')))
  folders.push(folder)
  return folder
}

type Fixture = { parent: string; source: string; out: string; live: string; session: string }

function fixture(canvas: CanvasKind = 'static', chat: ChatKind = 'answered'): Fixture {
  const parent = folder_create()
  const source = path.join(parent, 'source')
  const live = path.join(parent, 'live')
  fs.mkdirSync(live)
  const { session } = legacy_board_write(source, canvas, chat)
  return { parent, source, out: path.join(parent, 'native'), live, session }
}

function rehearse(at: Fixture, changes: Partial<Parameters<typeof native_rehearse>[0]> = {}) {
  return native_rehearse({
    source_directory: at.source,
    session: at.session,
    output_directory: at.out,
    live_directory: at.live,
    id_create: () => epoch,
    ...changes,
  })
}

// Every entry under `root`, with its mode and, for a file, a digest of its bytes. Walked with
// an explicit stack, bounded by the entries a fixture holds.
function tree(root: string): Record<string, string> {
  const found: Record<string, string> = {}
  const pending = ['']

  while (pending.length > 0) {
    const relative = pending.pop() as string
    const stat = fs.lstatSync(path.join(root, relative))
    const mode = (stat.mode & 0o7777).toString(8)

    if (Object.keys(found).length > entries_count_max) throw new Error('the tree is bounded')

    if (stat.isSymbolicLink()) {
      found[relative] = `link ${fs.readlinkSync(path.join(root, relative))}`
    } else if (stat.isDirectory()) {
      found[`${relative}/`] = mode

      for (const name of fs.readdirSync(path.join(root, relative))) {
        pending.push(path.join(relative, name))
      }
    } else {
      const bytes = fs.readFileSync(path.join(root, relative))
      found[relative] = `${mode} ${createHash('sha256').update(bytes).digest('hex')}`
    }
  }

  return found
}

function registry_open(root: string): BoardRegistry {
  return BoardRegistry.open({
    time: time_real,
    disk: disk_open(root),
    ...session_storage(root),
    id_create: () => '0123456789abcdef',
  })
}

function board_of(registry: BoardRegistry, session: string) {
  const lookup = registry.board(session)

  if (lookup.kind !== 'board') throw new Error(`the board did not open: ${lookup.kind}`)

  return lookup.board
}

test('a static linked board becomes a private native copy; the source stays as it was', () => {
  const at = fixture()
  const before = tree(at.source)
  const result = rehearse(at)
  expect(result).toMatchObject({
    kind: 'rehearsed',
    session: at.session,
    output_directory: at.out,
    agent_records_count: 9,
    agent_revision: 2,
    agent_history_count: 1,
    chat_events_count: 1,
  })
  expect(tree(at.source)).toEqual(before)
  expect(fs.readdirSync(at.parent).sort()).toEqual(['live', 'native', 'source'])

  // Private all the way down, with the same key, so the same binding speaks for both copies.
  const copied = tree(at.out)
  const board_files = ['agent_canvas.archive', 'board.snapshot', 'events.state', 'native.journal']
  expect(Object.keys(copied).sort()).toEqual(
    [
      '/',
      'sessions.registry',
      'sessions/',
      `sessions/${at.session}/`,
      ...board_files.map((name) => `sessions/${at.session}/${name}`),
      'whiteboard.key',
    ].sort(),
  )

  for (const [entry, value] of Object.entries(copied)) {
    expect([entry, value.split(' ')[0]]).toEqual([entry, entry.endsWith('/') ? '700' : '600'])
  }

  expect(copied['whiteboard.key']).toBe(before['whiteboard.key']!.replace(/^\d+/, '600'))
  const board_path = (name: string) => `sessions/${at.session}/${name}`
  expect(copied[board_path('events.state')]).toBe(before[board_path('events.state')])
  expect(copied[board_path('agent_canvas.archive')]!.split(' ')[1]).toBe(
    before[board_path('cleaned.state')]!.split(' ')[1],
  )

  copy_check(at)
  source_reopen_check(at)
})

// The copy as the server opens it: the same board, native, the sketch exact, the canvas on top.
function copy_check(at: Fixture): void {
  const source = registry_open(at.source)
  const copy = registry_open(at.out)

  try {
    expect(copy.list()).toEqual([source.find(at.session)!])
    expect(copy.owner(at.session)).toBe(rehearsal_owner)
    const original = board_of(source, at.session)
    const native = board_of(copy, at.session)
    expect(original.native).toBeNull()
    expect(native.native).not.toBeNull()

    const records = native.native!.scene_read().records as unknown as Json[]
    const by_id = new Map(records.map((record) => [record.id, record]))

    for (const stroke of sketch_strokes) expect(by_id.get(stroke.id)).toEqual(stroke as Json)

    canvas_check(original.cleaned_document().records as Json[], by_id)

    // The chat came across whole, and there is no separate Agent canvas to show twice.
    expect(native.events.chat()).toEqual(original.events.chat())
    expect(native.cleaned_status()).toMatchObject({ revision: 0, current: null, history: [] })
  } finally {
    source.close()
    copy.close()
  }

  const key = new TextDecoder().decode(fs.readFileSync(path.join(at.out, 'whiteboard.key')))
  const source_file = path.join(at.source, 'whiteboard.key')
  const source_key = new TextDecoder().decode(fs.readFileSync(source_file))
  expect(scoped_key(key, 'host', at.session, rehearsal_owner)).toBe(
    scoped_key(source_key, 'host', at.session, rehearsal_owner),
  )
}

// Each canvas record is in the scene as published. Only a shape directly on the page has a new
// index, and those keep the canvas's order, under every stroke, as the print was drawn.
function canvas_check(canvas: Json[], by_id: Map<string, Json>): void {
  expect(canvas.length).toBe(9)
  const page_level = canvas.filter((record) => record.parentId === 'page:page')
  const ordered = [...page_level].sort((a, b) => (a.index < b.index ? -1 : 1))

  for (const record of canvas) {
    const placed = by_id.get(record.id)!
    const moved = page_level.includes(record)
    expect({ ...placed, index: moved ? record.index : placed.index } as Json).toEqual(record)
  }

  const indices = ordered.map((record) => by_id.get(record.id)!.index as string)
  expect([...indices].sort()).toEqual(indices)
  expect(indices.every((index) => index < 'a1')).toBe(true)
  expect(by_id.get('shape:scene-api')!.props.color).toBe('green')
  expect(by_id.get('shape:scene-writes')!.props.color).toBe('violet')
  expect(by_id.get('shape:scene-title')!.parentId).toBe('shape:scene-notes')
}

function source_reopen_check(at: Fixture): void {
  const source = registry_open(at.source)

  try {
    const board = board_of(source, at.session)
    expect(board.native).toBeNull()
    expect(board.cleaned_status()).toMatchObject({ revision: 2 })
    expect(source.owner(at.session)).toBe(rehearsal_owner)
  } finally {
    source.close()
  }
}

type Refusal = readonly [name: string, kind: string, prepare: (at: Fixture) => Partial<Fixture>]

// Each way a board or a folder is refused, before anything is written.
const refusals: readonly Refusal[] = [
  ['the original board', 'board_default', () => ({ session: 'default' })],
  ['an unlisted id', 'board_not_found', () => ({ session: 'ffffffffffffffff' })],
  ['an unlinked board', 'board_not_linked', (at) => ({ session: board_add(at, null) })],
  ['a native board', 'board_native', (at) => ({ session: board_add(at, 'native-host') })],
  ['a damaged sketch', 'board_damaged', (at) => file_damage(at, 'board.snapshot')],
  ['a damaged chat', 'board_damaged', (at) => file_damage(at, 'events.state')],
  ['a public key', 'key_unsafe', (at) => chmod(path.join(at.source, 'whiteboard.key'), 0o644)],
  ['a running board', 'source_active', (at) => server_claim(at)],
  ['the data directory in use', 'source_live', (at) => ({ live: at.source })],
  ['a missing source', 'source_missing', (at) => ({ source: path.join(at.parent, 'nowhere') })],
  ['an existing output', 'output_exists', (at) => folder_make(at.out)],
  ['a dangling link as output', 'output_exists', (at) => link_make('/nowhere', at.out)],
  ['an output inside the source', 'output_alias', (at) => ({ out: path.join(at.source, 'n') })],
  ['an output through a link', 'output_alias', (at) => alias_into_source(at)],
  ['an output in no folder', 'output_alias', (at) => ({ out: path.join(at.parent, 'a', 'b') })],
  ['an output in the live folder', 'output_alias', (at) => ({ out: path.join(at.live, 'n') })],
  ['a leftover partial', 'board_unsupported', (at) => board_file(at, 'board.snapshot.tmp')],
  ['a retired canvas file', 'board_unsupported', (at) => board_file(at, 'ideas.state')],
  ['a linked board folder', 'board_damaged', (at) => board_folder_linked(at)],
  ['a second page', 'board_ambiguous', (at) => page_add(at)],
]

for (const [name, kind, prepare] of refusals) {
  test(`refused before writing: ${name}`, () => {
    const at = fixture()
    const changed = { ...at, ...prepare(at) }
    const before = tree(at.source)
    const outputs = fs.readdirSync(at.parent).sort()
    const result = rehearse(at, {
      session: changed.session,
      source_directory: changed.source,
      output_directory: changed.out,
      live_directory: changed.live,
    })
    expect(result.kind as string).toBe(kind)
    refused_check(at, before, outputs, result)
  })
}

for (const [canvas, chat, kind, prepare] of [
  ['static', 'open', 'board_outstanding', () => undefined],
  ['interactive', 'answered', 'board_ambiguous', (at: Fixture) => view_mark_add(at)],
] as const) {
  test(`refused before writing: ${canvas} canvas, ${chat} chat, ${kind}`, () => {
    const at = fixture(canvas, chat)
    prepare(at)
    const before = tree(at.source)
    const outputs = fs.readdirSync(at.parent).sort()
    const result = rehearse(at)
    expect(result.kind).toBe(kind)
    refused_check(at, before, outputs, result)
  })
}

// Every element of every view is carried, under the id each view gave it. Each view the copy
// can show is the view the print showed, shape for shape, at the same place on the page.
test('a canvas with views keeps every element; each view shows what the print showed', () => {
  const at = fixture('interactive')
  const before = tree(at.source)
  const result = rehearse(at)
  expect(result).toMatchObject({
    kind: 'rehearsed',
    agent_revision: 1,
    agent_history_count: 0,
    view_controls_count: 3,
  })
  expect(tree(at.source)).toEqual(before)
  const source = registry_open(at.source)
  const copy = registry_open(at.out)

  try {
    const original = board_of(source, at.session)
    const records = board_of(copy, at.session).native!.scene_read().records as unknown as Json[]
    const by_id = new Map(records.map((record) => [record.id, record]))

    for (const stroke of sketch_strokes) expect(by_id.get(stroke.id)).toEqual(stroke as Json)

    const controls = views_controls_read(document_of(at.out, at.session).meta)
    const rest = original.cleaned_view(null)

    if (rest.kind !== 'view') throw new Error('the legacy view at rest was refused')

    expect(controls as unknown).toEqual(rest.view.controls.map(control_full))
    const states = states_all(controls!)
    expect(states.length).toBe(12)

    for (const state of states) {
      const shown = original.cleaned_view(state)

      if (shown.kind !== 'view') throw new Error('a legacy view was refused')

      expect([state, shapes_shown(records, controls!, state)]).toEqual([
        state,
        shapes_placed(shown.view.records as Json[]),
      ])
    }

    // What the rest view hides is in the scene all the same, with the view it belongs to.
    expect(by_id.get('shape:scene-snow')!.meta.view).toEqual({
      visible_when: [{ control: 'season', values: ['winter'] }],
      on_tap: { control: 'season', value: 'summer' },
    })
    expect(by_id.get('shape:scene-house')!.meta).toEqual({})
    expect(records.filter((record) => record.typeName === 'binding')).toHaveLength(2)
  } finally {
    source.close()
    copy.close()
  }
})

// A canvas whose views are only in an earlier revision has one view now: that is carried, and
// the earlier revisions, views and all, stay in the archive byte for byte.
test('views of an earlier revision stay in the archive; the current one is carried', () => {
  const at = fixture('hidden')
  const result = rehearse(at)
  expect(result).toMatchObject({ kind: 'rehearsed', agent_revision: 2, view_controls_count: 0 })
  const archive = fs.readFileSync(path.join(at.out, 'sessions', at.session, 'agent_canvas.archive'))
  expect(archive.equals(fs.readFileSync(board_path(at, 'cleaned.state')))).toBe(true)
  expect(document_of(at.out, at.session).meta).toEqual({})
  const copy = registry_open(at.out)

  try {
    const records = board_of(copy, at.session).native!.scene_read().records as unknown as Json[]
    expect(records.some((record) => Object.hasOwn(record.meta ?? {}, 'view'))).toBe(false)
  } finally {
    copy.close()
  }
})

// The controls as the board serves them, with a toggle's implied options written out.
function control_full(control: Json): Json {
  const options = control.options ?? [
    { value: 'off', label: 'Off' },
    { value: 'on', label: 'On' },
  ]
  return { ...control, options }
}

// Every view state of the controls, counted and bounded by their product.
function states_all(controls: readonly Json[]): Record<string, string>[] {
  let states: Record<string, string>[] = [{}]

  for (const control of controls) {
    const values = (control.options as { value: string }[]).map((option) => option.value)
    states = states.flatMap((state) => values.map((value) => ({ ...state, [control.id]: value })))
    expect(states.length).toBeLessThanOrEqual(entries_count_max)
  }

  return states
}

// What a page shows of a native scene in one view, judged as the canvas judges it: a shape
// whose own marks hold, in groups that are shown, and an arrow only with both of its ends.
function shapes_shown(
  records: readonly Json[],
  controls: NonNullable<ReturnType<typeof views_controls_read>>,
  state: Record<string, string>,
): Json {
  const by_id = new Map(records.map((record) => [record.id, record]))
  const effect = { controls, state }
  const own = (record: Json) => shape_view_shown(shape_view_read(record.meta, controls), effect)
  const placed: Json[] = []

  for (const record of records) {
    if (record.typeName !== 'shape' || !String(record.id).startsWith('shape:scene-')) continue

    let shown = own(record)

    for (let parent = shape_of(by_id, record.parentId); parent !== undefined;) {
      shown = shown && own(parent)
      parent = shape_of(by_id, parent.parentId)
    }

    for (const binding of records) {
      if (binding.typeName === 'binding' && binding.fromId === record.id) {
        shown = shown && own(by_id.get(binding.toId)!)
      }
    }

    if (shown) placed.push(record)
  }

  return shapes_placed(placed, by_id)
}

// The leaf shapes, by id, each with its page position and how it is drawn. A group only
// carries its shapes, and a view may dissolve it, so it is judged by them.
function shapes_placed(records: readonly Json[], all = new Map<string, Json>()): Json {
  const by_id = new Map([...all, ...records.map((record) => [record.id, record] as const)])
  const placed: Json = {}

  for (const record of records) {
    if (record.typeName !== 'shape' || record.type === 'group') continue

    let [x, y] = [record.x as number, record.y as number]

    for (let parent = shape_of(by_id, record.parentId); parent !== undefined;) {
      expect(parent.rotation).toBe(0)
      ;[x, y] = [x + parent.x, y + parent.y]
      parent = shape_of(by_id, parent.parentId)
    }

    const { type, props, rotation, opacity } = record
    const [page_x, page_y] = [Math.round(x * 1000), Math.round(y * 1000)]
    placed[record.id] = { page_x, page_y, type, props, rotation, opacity }
  }

  return placed
}

// The group a shape is in, or undefined on the page.
function shape_of(by_id: ReadonlyMap<string, Json>, id: string): Json | undefined {
  const found = by_id.get(id)
  return found?.typeName === 'shape' ? found : undefined
}

function document_of(root: string, session: string): Json {
  const file = path.join(root, 'sessions', session, 'board.snapshot')
  const decoded = envelope_decode(new Uint8Array(fs.readFileSync(file)), 'board')

  if (!decoded.ok) throw new Error('the copy is readable')

  const room = JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
  const states = room.documents.map((document: Json) => document.state as Json)
  return states.find((state: Json) => state.typeName === 'document')
}

// A failure while writing leaves the source as it was, and no output or staging folder.
test('a failed write or check leaves no partial copy behind', () => {
  const at = fixture()
  const before = tree(at.source)
  const outputs = fs.readdirSync(at.parent).sort()
  const failing = rehearse(at, {
    id_create: () => {
      throw Object.assign(new Error('disk full'), { code: 'ENOSPC' })
    },
  })
  expect(failing.kind).toBe('output_failed')
  expect((failing as { message: string }).message).toContain('ENOSPC')
  refused_check(at, before, outputs, failing)

  // A folder that cannot be written to refuses the staging folder itself.
  fs.chmodSync(at.parent, 0o500)
  const locked = rehearse(at)
  fs.chmodSync(at.parent, 0o700)
  expect(locked.kind).toBe('output_failed')
  refused_check(at, before, outputs, locked)

  // The same source then rehearses cleanly: nothing of the failures was left to trip over.
  expect(rehearse(at).kind).toBe('rehearsed')
  expect(tree(at.source)).toEqual(before)
})

test('canvas shapes stack under the sketch in their own order, with valid keys', () => {
  const stroke = { ...sketch_strokes[0], index: 'a5V' } as Json
  const room = {
    clock: 7,
    documents: [
      { state: { id: 'document:document', typeName: 'document' }, lastChangedClock: 1 },
      { state: { id: 'page:page', typeName: 'page' }, lastChangedClock: 1 },
      { state: stroke, lastChangedClock: 7 },
    ],
  }
  const count = 3000
  const canvas = Array.from({ length: count }, (_, place) => ({
    ...(sketch_strokes[1] as Json),
    id: `shape:scene-s${place}`,
    index: index_key(count - 1 - place),
  }))
  const plan = room_plan(room, canvas as never)

  if (!plan.ok) throw new Error(plan.message)

  const placed = plan.agent.map((record) => [record.id, (record as Json).index as string])
  const by_canvas_order = [...placed].sort((a, b) => (a[0]! < b[0]! ? -1 : 1))
  expect(placed.map(([, index]) => index).every((index) => index! < 'a5V')).toBe(true)
  expect(new Set(placed.map(([, index]) => index)).size).toBe(count)

  // The canvas order is the reverse of the ids' order: the last placed is the lowest key.
  const keys = canvas.map((record) => placed.find(([id]) => id === record.id)![1])
  expect([...keys].sort().reverse()).toEqual(keys)
  expect(plan.snapshot.documents.length).toBe(3 + count)
  expect(by_canvas_order.length).toBe(count)

  // A canvas shape that reuses a sketch id is a guess about which one is meant: refused.
  const clash = room_plan(room, [{ ...canvas[0], id: stroke.id }] as never)
  expect(clash).toMatchObject({ ok: false, kind: 'board_ambiguous' })
})

// Counting down past zeros moves to the previous letter; each case still sorts under the
// sketch, and the plan itself checks every key against tldraw's schema.
test('keys under a sketch at the bottom of its letter, and under a malformed key', () => {
  const room_at = (index: unknown) => ({
    clock: 1,
    documents: [
      { state: { id: 'page:page', typeName: 'page' }, lastChangedClock: 1 },
      { state: { ...(sketch_strokes[0] as Json), index }, lastChangedClock: 1 },
    ],
  })
  const canvas = [{ ...(sketch_strokes[1] as Json), id: 'shape:scene-a', index: 'a1' }]

  // A stroke above the first key tldraw gives still finds the canvas under that key.
  for (const [bottom, head] of [
    ['a0', 'Zz'],
    ['b00', 'a0'],
    ['Z0', 'Yzz'],
    ['a0V', 'Zz'],
  ]) {
    const plan = room_plan(room_at(bottom), canvas as never)

    if (!plan.ok) throw new Error(plan.message)

    const index = (plan.agent[0] as Json).index as string
    expect([bottom, index.slice(0, head!.length)]).toEqual([bottom, head])
    expect(index < bottom!).toBe(true)
  }

  for (const malformed of ['', '0a', 'b0', 7]) {
    expect(room_plan(room_at(malformed), canvas as never)).toMatchObject({
      ok: false,
      kind: 'board_ambiguous',
    })
  }
})

function refused_check(
  at: Fixture,
  before: Record<string, string>,
  outputs: readonly string[],
  result: RehearsalResult,
): void {
  expect(result.kind).not.toBe('rehearsed')
  expect(String((result as { message: string }).message)).toMatch(/\.$/)
  expect(tree(at.source)).toEqual(before)
  expect(fs.readdirSync(at.parent).sort()).toEqual([...outputs])
}

function board_add(at: Fixture, owner: string | null): string {
  const registry = registry_open(at.source)

  try {
    const result = owner === null ? registry.create(null) : registry.link(owner, true)

    if (result.kind !== 'created') throw new Error('the extra board was not made')

    return result.session.id
  } finally {
    registry.close()
  }
}

function board_path(at: Fixture, name: string): string {
  return path.join(at.source, 'sessions', at.session, name)
}

function file_damage(at: Fixture, name: string): Partial<Fixture> {
  const bytes = fs.readFileSync(board_path(at, name))
  bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 0x01
  fs.writeFileSync(board_path(at, name), bytes)
  return {}
}

function board_file(at: Fixture, name: string): Partial<Fixture> {
  fs.writeFileSync(board_path(at, name), 'left over', { mode: 0o600 })
  return {}
}

function chmod(file: string, mode: number): Partial<Fixture> {
  fs.chmodSync(file, mode)
  return {}
}

function server_claim(at: Fixture): Partial<Fixture> {
  const state = JSON.stringify({ pid: process.pid, port: 1 })
  fs.writeFileSync(path.join(at.source, 'server.json'), `${state}\n`)
  return {}
}

function folder_make(folder: string): Partial<Fixture> {
  fs.mkdirSync(folder)
  return {}
}

function link_make(target: string, link: string): Partial<Fixture> {
  fs.symlinkSync(target, link)
  return {}
}

// A link beside the source that leads into it: the output would land inside the source.
function alias_into_source(at: Fixture): Partial<Fixture> {
  fs.symlinkSync(at.source, path.join(at.parent, 'alias'))
  return { out: path.join(at.parent, 'alias', 'native') }
}

// The board folder replaced by a link to a real copy of it elsewhere.
function board_folder_linked(at: Fixture): Partial<Fixture> {
  const folder = path.join(at.source, 'sessions', at.session)
  const elsewhere = path.join(at.parent, 'elsewhere')
  fs.renameSync(folder, elsewhere)
  fs.symlinkSync(elsewhere, folder)
  return {}
}

function page_add(at: Fixture): Partial<Fixture> {
  return room_change(at, (room) => {
    const page = { id: 'page:second', typeName: 'page', name: 'Page 2', index: 'a2', meta: {} }
    room.documents.push({ state: page, lastChangedClock: room.clock })
  })
}

// A stroke of the sketch already bearing the mark views are told apart by.
function view_mark_add(at: Fixture): Partial<Fixture> {
  return room_change(at, (room) => {
    const stroke = room.documents.find((document: Json) => document.state.id === 'shape:hill')
    stroke.state.meta = { view: { visible_when: [{ control: 'season', values: ['winter'] }] } }
  })
}

function room_change(at: Fixture, change: (room: Json) => void): Partial<Fixture> {
  const file = board_path(at, 'board.snapshot')
  const decoded = envelope_decode(new Uint8Array(fs.readFileSync(file)), 'board')

  if (!decoded.ok) throw new Error('the fixture sketch is readable')

  const room = JSON.parse(new TextDecoder().decode(decoded.envelope.payload))
  change(room)
  const payload = new TextEncoder().encode(JSON.stringify(room))
  fs.writeFileSync(file, envelope_encode({ kind: 'board', label: '-', payload }))
  return {}
}
