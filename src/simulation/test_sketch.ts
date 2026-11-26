// Fixtures for cleanup tests: a disk holding a saved sketch of a few squares, as an older
// version of the board would have left it, and a valid cleanup proposal for any snapshot.

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
import { proposal_format } from '../shared/cleanup_types'
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

// A proposal with one of each kind: two boxes joined by a labelled arrow, and a title.
export function proposal_example(snapshot: string, base_revision: number, title = 'Checkout') {
  return {
    format: proposal_format,
    snapshot,
    base_revision,
    agent: 'test-agent',
    summary: 'Two services and a title.',
    shapes: [
      { kind: 'text', id: 'title', x: 0, y: -80, text: title, size: 'l' },
      { kind: 'rectangle', id: 'api', x: 0, y: 0, w: 160, h: 80, text: 'API' },
      { kind: 'ellipse', id: 'db', x: 300, y: 0, w: 120, h: 80, text: 'DB', color: 'blue' },
      { kind: 'arrow', id: 'writes', from: 'api', to: 'db', text: 'writes' },
    ],
  }
}
