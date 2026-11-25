import type { Editor, TLRecord } from 'tldraw'
import { cleaned_page_id, type CleanedDocument } from '../shared/cleanup_types'

// Paste remaps ids and both binding endpoints. Roll back incomplete pastes before leaving edit.
export function replace_sketch(editor: Editor, document: CleanedDocument): boolean {
  const records = document.records as TLRecord[]
  const shapes = records.filter((r) => r.typeName === 'shape')
  const bindings = records.filter((r) => r.typeName === 'binding')

  if (!shapes.length || shapes.length > editor.options.maxShapesPerPage) return false

  const rootShapeIds = shapes.filter((s) => s.parentId === cleaned_page_id).map((s) => s.id)

  if (!rootShapeIds.length) return false

  const mark = editor.markHistoryStoppingPoint('replace sketchboard')

  try {
    editor.run(() => {
      const prior = [...editor.getCurrentPageShapeIds()]
      editor.selectNone().deleteShapes(prior)
      editor.putContentOntoCurrentPage(
        { shapes, bindings, rootShapeIds, assets: [], schema: editor.store.schema.serialize() },
        { preservePosition: true },
      )
      const ids = editor.getCurrentPageShapeIds()

      if (ids.size !== shapes.length || prior.some((id) => ids.has(id))) {
        throw Error('Incomplete paste')
      }

      let copied = 0

      for (const id of ids) {
        for (const b of editor.getBindingsFromShape(id, 'arrow')) {
          if (!ids.has(b.toId)) throw Error('Disconnected copy')

          copied++
        }
      }

      if (copied !== bindings.length) throw Error('Incomplete bindings')
    })
    editor.markHistoryStoppingPoint()
    editor.setCurrentTool('select')
    editor.zoomToFit()
    return true
  } catch {
    editor.bailToMark(mark)
    return false
  }
}
