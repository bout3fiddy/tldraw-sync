// The disposable native-scene page: the stock tldraw editor synced to the fixture room, nothing
// of the product around it. `?role=ipad` edits; `?role=mac` is the read-only stage session.
// The editor is exposed as `window.native_scene_editor` so the journey can read records and
// map page points to the screen; every edit it checks is made with real pointer and keys.

import { useSync } from '@tldraw/sync'
import { createRoot } from 'react-dom/client'
import { Tldraw, type Editor, type TLAssetStore } from 'tldraw'
import 'tldraw/tldraw.css'

type NativeSceneWindow = Window & { native_scene_editor?: Editor }

const role = new URLSearchParams(window.location.search).get('role') === 'mac' ? 'mac' : 'ipad'
const socket_origin = window.location.origin.replace(/^http/, 'ws')

// The scene holds no images; refusing uploads keeps the fixture free of any asset storage.
const assets: TLAssetStore = {
  upload: async () => {
    throw new Error('the native scene fixture stores no assets')
  },
  resolve: (asset) => asset.props.src,
}

function Scene() {
  const store = useSync({ uri: `${socket_origin}/sync/${role}`, assets })

  return (
    <div style={{ position: 'fixed', inset: 0 }}>
      <Tldraw
        store={store}
        onMount={(editor) => {
          ;(window as NativeSceneWindow).native_scene_editor = editor
          document.body.dataset.role = role
        }}
      />
    </div>
  )
}

const root = document.getElementById('root')

if (root === null) throw new Error('the fixture page has no root element')

createRoot(root).render(<Scene />)
