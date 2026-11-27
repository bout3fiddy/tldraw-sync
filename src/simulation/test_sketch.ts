// Fixtures for canvas tests: a disk holding a saved sketch of a few squares, as an older
// version of the board would have left it, and a valid scene proposal for any snapshot.

import {
  createTLSchema,
  DocumentRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  type TLPage,
  type TLRecord,
} from '@tldraw/tlschema'
import { envelope_encode } from '../server/storage'
import { assert } from '../shared/assert'
import { board_default_id } from '../shared/board_session'
import { scene_format } from '../shared/scene_types'
import { SimulatedDisk } from './simulated_disk'

const schema = createTLSchema()

export function sketch_square(shape_id: string, x: number): TLRecord {
  assert(shape_id.startsWith('shape:'), 'a shape id has the shape prefix')
  return {
    id: shape_id, typeName: 'shape', type: 'geo', x, y: 0, rotation: 0, index: 'a1',
    parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
    props: {
      w: 10, h: 10, geo: 'rectangle', color: 'black', labelColor: 'black', fill: 'none',
      dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle',
      growY: 0, url: '', scale: 1, richText: { type: 'doc', content: [] },
    },
  } as unknown as TLRecord
}

// A pen stroke as the iPad draws one: where it starts on the page, its pen samples relative to
// that point, and its ink. One stroke is one native tldraw draw shape.
export function sketch_stroke(
  shape_id: string,
  x: number,
  y: number,
  points: ReadonlyArray<readonly [number, number]>,
  color = 'black',
): TLRecord {
  assert(shape_id.startsWith('shape:'), 'a shape id has the shape prefix')
  assert(points.length > 0, 'a stroke has pen samples')
  return {
    id: shape_id, typeName: 'shape', type: 'draw', x, y, rotation: 0, index: 'a1',
    parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
    props: {
      color, fill: 'none', dash: 'draw', size: 'm', isComplete: true, isClosed: false,
      isPen: true, scale: 1,
      segments: [{ type: 'free', points: points.map(([px, py]) => ({ x: px, y: py, z: 0.5 })) }],
    },
  } as unknown as TLRecord
}

// Writes a saved board holding these shapes, replacing any board already on the disk.
export function sketch_save(disk: SimulatedDisk, shapes: readonly TLRecord[]): void {
  const records = [
    DocumentRecordType.create({ id: TLDOCUMENT_ID }),
    PageRecordType.create({
      id: PageRecordType.createId('page'), name: 'Page 1', index: 'a1' as TLPage['index'],
    }),
    ...shapes,
  ]
  const snapshot = {
    clock: 1,
    schema: schema.serialize(),
    documents: records.map((state) => ({ state, lastChangedClock: 1 })),
  }
  const payload = new TextEncoder().encode(JSON.stringify(snapshot))
  disk.write_atomic('board.snapshot', envelope_encode({ kind: 'board', label: '-', payload }))
}

export function sketch_disk(shapes: readonly TLRecord[]): SimulatedDisk {
  const disk = new SimulatedDisk()
  sketch_save(disk, shapes)
  return disk
}

// A scene with one control of each kind. At rest (summer, plan, labels off) it shows the house,
// the sun, the arrow from the sun, and the caption, lifted out of a group that holds only it.
// In winter the snow replaces the sun, and the arrow, bound to the sun, goes with it. With the
// labels on the group holds the note and the caption again. Taps on the sun and the snow swap
// the season.
export function scene_controlled(
  snapshot: string,
  base_revision: number,
  session: string = board_default_id,
) {
  const option = (value: string) => ({ value, label: value.toUpperCase() })
  const summer = [{ control: 'season', values: ['summer'] }]
  const winter = [{ control: 'season', values: ['winter'] }]
  return {
    format: scene_format,
    session,
    snapshot,
    base_revision,
    agent: 'test-agent',
    summary: 'A house in two seasons.',
    controls: [
      { id: 'season', kind: 'choice', label: 'Season', options: ['summer', 'winter'].map(option) },
      {
        id: 'stage', kind: 'steps', label: 'Stage', options: ['plan', 'build', 'ship'].map(option),
      },
      { id: 'labels', kind: 'toggle', label: 'Labels' },
    ] as Array<Record<string, any>>,
    elements: [
      { type: 'geo', id: 'house', x: 0, y: 0, w: 100, h: 100, text: 'House' },
      {
        type: 'geo', id: 'sun', geo: 'ellipse', x: 200, y: -100, w: 40, h: 40,
        visible_when: summer, on_tap: { control: 'season', value: 'winter' },
      },
      {
        type: 'geo', id: 'snow', geo: 'cloud', x: 200, y: -100, w: 60, h: 40,
        visible_when: winter, on_tap: { control: 'season', value: 'summer' },
      },
      { type: 'arrow', id: 'shine', from: 'sun', to: 'house' },
      {
        type: 'text', id: 'note', x: 0, y: 140, text: 'Built 1902', parent: 'tags',
        visible_when: [{ control: 'labels', values: ['on'] }],
      },
      { type: 'text', id: 'caption', x: 0, y: 180, text: 'Home', parent: 'tags' },
      { type: 'group', id: 'tags' },
      {
        type: 'text', id: 'crane', x: 120, y: 0, text: 'Crane',
        visible_when: [{ control: 'stage', values: ['build', 'ship'] }],
      },
    ] as Array<Record<string, any>>,
  }
}

// A scene with a title and two shapes joined by a labelled, bound arrow, for one board.
export function scene_example(
  snapshot: string,
  base_revision: number,
  title = 'Checkout',
  session: string = board_default_id,
) {
  return {
    format: scene_format,
    session,
    snapshot,
    base_revision,
    agent: 'test-agent',
    summary: 'Two services and a title.',
    elements: [
      { type: 'text', id: 'title', x: 0, y: -80, text: title, size: 'l' },
      { type: 'geo', id: 'api', x: 0, y: 0, w: 160, h: 80, text: 'API' },
      { type: 'geo', id: 'db', geo: 'ellipse', x: 300, y: 0, w: 120, h: 80, text: 'DB' },
      { type: 'arrow', id: 'writes', from: 'api', to: 'db', text: 'writes' },
    ] as Array<Record<string, unknown>>,
  }
}
