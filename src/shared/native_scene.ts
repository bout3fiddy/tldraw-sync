// What a native board, its pages and its host agree on. On a native board the agent and the
// person edit one scene of tldraw records. Every agent write and every undo or redo of one is a
// numbered revision the board keeps (`src/server/native_scene.ts`). The push that applies a
// revision also writes `native_revision` into the document record's meta, so a page learns of
// each revision in the same sync message as its records, in order with the person's own edits.
// The marker is only a hint for ordering a page's undo: the board decides every revert itself.

import { assert } from './assert'

export const native_marker_key = 'native_revision'

// `reverts` is the revision a revert took back, or null for an agent edit.
export type NativeMarker = { readonly sequence: number; readonly reverts: number | null }

// Routes under `whiteboard_path`. The host reads and edits with its binding; a paired pad
// reverts, which is how its Undo and Redo reach an agent revision.
export const native_route_scene = 'native/scene'
export const native_route_edit = 'native/edit'
export const native_route_revert = 'native/revert'

export const native_edit_bytes_max = 1024 * 1024 + 4096
export const native_revert_bytes_max = 256

// A retry names the same request id; a new request should name a new one.
export const native_request_id_pattern = /^[A-Za-z0-9_-]{8,64}$/

export function native_marker_read(meta: unknown): NativeMarker | null {
  if (typeof meta !== 'object' || meta === null) return null

  const value = (meta as Record<string, unknown>)[native_marker_key]

  if (typeof value !== 'object' || value === null) return null

  const { sequence, reverts } = value as { sequence?: unknown; reverts?: unknown }

  if (!sequence_valid(sequence)) return null

  if (reverts !== null && !sequence_valid(reverts)) return null

  // Meta is writable by any page: a marker that could not have been written is ignored.
  if (reverts !== null && reverts >= sequence) return null

  const marker = { sequence, reverts: reverts as number | null }
  assert(marker.sequence >= 1, 'a marker names a revision')
  assert(marker.reverts === null || marker.reverts < marker.sequence, 'a revert is newer')
  return marker
}

export function sequence_valid(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1
}
