// Seed a fresh native room with one synthetic season drawing for the browser journey.
import { createTLSchema, DocumentRecordType, PageRecordType, TLDOCUMENT_ID } from '@tldraw/tlschema'
import type { TLPage } from '@tldraw/tlschema'
import { mkdirSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { BoardRegistry } from '../../src/server/board_registry'
import { scene_parse } from '../../src/server/scene_proposal'
import { scene_records } from '../../src/server/scene_records'
import { disk_open, envelope_encode, session_storage } from '../../src/server/storage'
import { time_real } from '../../src/shared/time'
import { scene_controlled } from '../../src/simulation/test_sketch'

const root = process.argv[2]

if (!root) throw new Error('Expected a new fixture directory.')

// Never open or replace an existing board.
mkdirSync(root, { mode: 0o700 })
const storage = session_storage(root)
const registry = BoardRegistry.open({
  disk: disk_open(root),
  ...storage,
  time: time_real,
  id_create: () => randomBytes(8).toString('hex'),
})

try {
  const linked = registry.link('native-views-test', true)

  if (linked.kind !== 'created') throw new Error(`Fixture link failed: ${linked.kind}`)

  const session = linked.session.id
  const drawing = scene_controlled('0'.repeat(16), 0, session)
  const parsed = scene_parse(drawing)

  if (!parsed.ok) throw new Error(parsed.message)

  const when = (control: string, value: string) => [{ control, values: [value] }]
  const season = (shown: string, tapped: string) => ({
    visible_when: when('season', shown),
    on_tap: { control: 'season', value: tapped },
  })
  const views = new Map<string, object>([
    ['shape:scene-sun', season('summer', 'winter')],
    ['shape:scene-snow', season('winter', 'summer')],
    ['shape:scene-note', { visible_when: when('labels', 'on') }],
    ['shape:scene-crane', { visible_when: when('stage', 'build') }],
  ])
  const records = [
    DocumentRecordType.create({ id: TLDOCUMENT_ID, meta: { view_controls: drawing.controls } }),
    PageRecordType.create({
      id: PageRecordType.createId('page'),
      name: 'Seasons',
      index: 'a1' as TLPage['index'],
    }),
    ...scene_records(parsed.proposal.elements).map((record) => {
      const view = views.get(record.id)
      return view ? { ...record, meta: { view } } : record
    }),
  ]
  const snapshot = {
    clock: 1,
    schema: createTLSchema().serialize(),
    documents: records.map((state) => ({ state, lastChangedClock: 1 })),
  }
  const payload = new TextEncoder().encode(JSON.stringify(snapshot))
  storage.disk_board(session).write_atomic(
    'board.snapshot',
    envelope_encode({
      kind: 'board',
      label: '-',
      payload,
    }),
  )
  console.log(JSON.stringify({ session }))
} finally {
  registry.close()
}
