import { expect, test } from 'bun:test'
import type { Editor } from 'tldraw'
import { cleaned_page_id, type CleanedDocument } from '../shared/cleanup_types'
import { replace_sketch } from './replace_sketch'

// Playwright covers real editable shapes and undo. Here fail the paste after deletion and require
// restoration to the initiating mark, including when native paste silently omits only a binding.
test('failed and partial native paste both restore the original ink', () => {
  const document = {
    records: [
      { id: 'shape:cleaned-a', typeName: 'shape', parentId: cleaned_page_id },
      { id: 'shape:cleaned-b', typeName: 'shape', parentId: cleaned_page_id },
      { id: 'binding:ab', typeName: 'binding' },
    ],
  } as unknown as CleanedDocument

  for (const drop_binding of [false, true]) {
    let ids = ['shape:ink']
    let before: string[] = []
    let restored = ''
    const editor = {
      options: { maxShapesPerPage: 800 },
      store: { schema: { serialize: () => ({}) } },
      markHistoryStoppingPoint: () => {
        before = [...ids]
        return 'mark'
      },
      run: (fn: () => void) => fn(),
      getCurrentPageShapeIds: () => new Set(ids),
      selectNone: () => ({
        deleteShapes: () => {
          ids = []
        },
      }),
      putContentOntoCurrentPage: () => {
        expect(ids).toHaveLength(0)

        if (!drop_binding) throw Error('paste failed')

        ids = ['shape:new-a', 'shape:new-b']
      },
      getBindingsFromShape: () => [],
      setCurrentTool: () => undefined,
      zoomToFit: () => undefined,
      bailToMark: (mark: string) => {
        restored = mark
        ids = before
      },
    }
    expect(replace_sketch(editor as unknown as Editor, document)).toBe(false)
    expect(ids).toEqual(['shape:ink'])
    expect(restored).toBe('mark')
  }
})
