// The live connection to the board on the Mac. Both pages use it; only the role differs.

import { getAssetUrlsByImport } from '@tldraw/assets/imports.vite'
import { useSync } from '@tldraw/sync'
import { useMemo } from 'react'
import type { TLAssetStore, TLComponents } from 'tldraw'
import { board_query } from '../shared/board_session'
import { path_sync, type Role } from '../shared/constants'

// Fonts and icons are served by the Mac, so the board works with no internet connection.
export const asset_urls = getAssetUrlsByImport()

// Nobody else's cursor belongs on this board: there is one pen, and the stage only watches.
export const components_quiet: TLComponents = {
  CollaboratorCursor: null,
  CollaboratorBrush: null,
  CollaboratorScribble: null,
  CollaboratorHint: null,
  CollaboratorShapeIndicator: null,
}

// The board holds pen strokes only. Pasted images have nowhere to be stored.
const asset_store: TLAssetStore = {
  upload: async () => {
    throw new Error('Images cannot be added to this board.')
  },
  resolve: (asset) => asset.props.src,
}

// One board session's room. The sync library adds its own `sessionId` for this connection.
export function use_board_store(role: Role, session: string) {
  const uri = useMemo(() => {
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws'
    return `${protocol}://${window.location.host}${path_sync}?role=${role}&${board_query(session)}`
  }, [role, session])
  // The stage tells a connected pen apart from another stage by this name.
  const user = useMemo(() => ({ id: `${role}-${user_suffix()}`, name: role }), [role])

  return useSync({ uri, assets: asset_store, userInfo: user })
}

// `crypto.randomUUID` is withheld from plain-HTTP pages, which is how the iPad loads this.
function user_suffix(): string {
  const values = crypto.getRandomValues(new Uint32Array(2))
  return `${values[0]?.toString(36)}${values[1]?.toString(36)}`
}
