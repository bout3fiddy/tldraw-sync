// A stopped data directory holding one linked legacy board, made with the board's own code: a
// sketch of two strokes, an Agent canvas published twice from it, and an answered chat. Used by
// the native rehearsal tests, in process, and by the browser journey, as a script:
//
//   bun tests/fixtures/native-rehearsal/legacy_board.ts <directory> <static|interactive|hidden>
//
// prints {"session": "<id>"} once the directory is complete and nothing holds it.

import {
  createTLSchema,
  DocumentRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  type TLPage,
  type TLRecord,
} from '@tldraw/tlschema'
import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { scene_format } from '../../../src/shared/scene_types'
import { time_real } from '../../../src/shared/time'
import { BoardRegistry } from '../../../src/server/board_registry'
import { disk_open, envelope_encode, session_storage } from '../../../src/server/storage'
import { machine_key } from '../../../src/server/whiteboard_keys'
import { scene_controlled } from '../../../src/simulation/test_sketch'
import { sketch_stroke } from '../../../src/simulation/test_sketch'

export const rehearsal_owner = 'rehearsal-host'
export type CanvasKind = 'static' | 'interactive' | 'hidden'
export type ChatKind = 'answered' | 'open'

// Two strokes in their own colours and order: the sun is drawn over the hill.
export const sketch_strokes: TLRecord[] = [
  {
    ...sketch_stroke(
      'shape:hill',
      0,
      10,
      [
        [0, 0],
        [5, -8],
        [10, 0],
      ],
      'blue',
    ),
    index: 'a1',
  },
  {
    ...sketch_stroke(
      'shape:sun',
      40,
      0,
      [
        [0, 0],
        [4, 4],
        [8, 0],
      ],
      'red',
    ),
    index: 'a2',
  },
] as TLRecord[]

// What the agent drew, with colours, a group, an arrow bound at both ends, and a copy of the
// hill moved beside it. Listed bottom to top.
export function canvas_elements(title: string): Record<string, unknown>[] {
  return [
    { type: 'geo', id: 'api', x: 0, y: 120, w: 160, h: 80, text: 'API', color: 'green' },
    { type: 'geo', id: 'db', geo: 'ellipse', x: 300, y: 120, w: 120, h: 80, text: 'DB' },
    { type: 'arrow', id: 'writes', from: 'api', to: 'db', text: 'writes', color: 'violet' },
    { type: 'group', id: 'notes' },
    { type: 'text', id: 'title', x: 0, y: -80, text: title, size: 'l', parent: 'notes' },
    { type: 'text', id: 'byline', x: 0, y: -40, text: 'by the agent', parent: 'notes' },
    { type: 'sketch', id: 'pic', strokes: ['shape:hill'], x: 200, y: 300 },
  ]
}

export function legacy_board_write(
  root: string,
  canvas: CanvasKind = 'static',
  chat: ChatKind = 'answered',
): { session: string } {
  const disk = disk_open(root)
  machine_key(disk)
  const environment = {
    time: time_real,
    disk,
    ...session_storage(root),
    id_create: () => randomBytes(8).toString('hex'),
  }
  const linking = BoardRegistry.open(environment)
  const linked = linking.link(rehearsal_owner)

  if (linked.kind !== 'created') throw new Error('the fixture board was not linked')

  const session = linked.session.id
  linking.close()
  sketch_write(environment.disk_board(session))

  const registry = BoardRegistry.open(environment)

  try {
    canvas_publish(registry, session, canvas)
    chat_write(registry, session, chat)
  } finally {
    registry.close()
  }

  return { session }
}

export function sketch_write(disk: ReturnType<typeof disk_open>): void {
  const schema = createTLSchema()
  const page_index = 'a1' as TLPage['index']
  const records = [
    DocumentRecordType.create({ id: TLDOCUMENT_ID }),
    PageRecordType.create({
      id: PageRecordType.createId('page'),
      name: 'Page 1',
      index: page_index,
    }),
    ...sketch_strokes,
  ]
  const snapshot = {
    clock: 3,
    schema: schema.serialize(),
    documents: records.map((state) => ({ state, lastChangedClock: 3 })),
  }
  const payload = new TextEncoder().encode(JSON.stringify(snapshot))
  disk.write_atomic('board.snapshot', envelope_encode({ kind: 'board', label: '-', payload }))
}

export function canvas_publish(
  registry: BoardRegistry,
  session: string,
  canvas: CanvasKind,
): void {
  const lookup = registry.board(session)

  if (lookup.kind !== 'board') throw new Error('the fixture board did not open')

  const hash = lookup.board.document_state().hash
  const header = { format: scene_format, session, snapshot: hash, agent: 'fixture-agent' }
  const first =
    canvas === 'static'
      ? {
          ...header,
          base_revision: 0,
          basis: 'sketch',
          summary: 'A first draft.',
          elements: canvas_elements('Checkout'),
        }
      : scene_controlled(hash, 0, session)

  // After a scene with controls, the copied hill is not on the canvas to keep, so it goes.
  const elements = canvas_elements('Checkout flow')
  const kept = canvas === 'static' ? elements : elements.filter((e) => e.type !== 'sketch')
  const second = {
    ...header,
    base_revision: 1,
    basis: 'canvas',
    summary: 'Renamed.',
    elements: kept,
  }
  const published = [registry.publish(session, first)]

  if (canvas !== 'interactive') published.push(registry.publish(session, second))

  for (const result of published) {
    if (result.kind !== 'published') throw new Error(`the fixture publish was ${result.kind}`)
  }
}

export function chat_write(registry: BoardRegistry, session: string, chat: ChatKind): void {
  const lookup = registry.board(session)

  if (lookup.kind !== 'board') throw new Error('the fixture board did not open')

  const stamp = Date.now().toString(16).padStart(12, '0')
  const request_id = `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-7aaa-8000-000000000001`
  const request = { request_id, text: 'Tidy the checkout', include_sketch: false }
  const queued = lookup.board.queue_event(null, request)

  if (typeof queued === 'string') throw new Error(`the fixture chat was refused: ${queued}`)

  if (chat === 'open') return

  for (const [state, message] of [['received'], ['updated', 'Drew the services.']] as const) {
    const answered = lookup.board.event_ack(queued.id, state, message)

    if (typeof answered === 'string') throw new Error(`the fixture ack was refused: ${answered}`)
  }
}

if (import.meta.main) {
  const [directory, kind] = process.argv.slice(2)

  if (directory === undefined || !path.isAbsolute(directory)) {
    throw new Error('Name an absolute directory.')
  }

  const canvas = (kind ?? 'static') as CanvasKind
  console.log(JSON.stringify(legacy_board_write(directory, canvas)))
}
