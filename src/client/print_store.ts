// A store holding one published canvas and nothing else: its page and its records as they were
// published, whatever format they were published in. The print is drawn from one, and the
// stage renders a draft from one, so a draft is drawn exactly as its publish would be shown.
// It never touches the sync room: nothing drawn from it can reach the person's ink.

import {
  createTLSchema,
  createTLStore,
  DocumentRecordType,
  PageRecordType,
  TLDOCUMENT_ID,
  type TLPage,
  type TLPageId,
  type TLRecord,
  type TLStore,
} from 'tldraw'
import { cleaned_page_id, type CanvasRecord } from '../shared/canvas_types'

const schema = createTLSchema()

export function canvas_store(records: readonly CanvasRecord[]): TLStore {
  const page = PageRecordType.create({
    id: cleaned_page_id as TLPageId,
    name: 'Agent canvas',
    index: 'a1' as TLPage['index'],
  })
  const all: TLRecord[] = [
    DocumentRecordType.create({ id: TLDOCUMENT_ID }),
    page,
    ...(records as TLRecord[]),
  ]
  const initialData = Object.fromEntries(all.map((record) => [record.id, record]))
  return createTLStore({ schema, initialData })
}
