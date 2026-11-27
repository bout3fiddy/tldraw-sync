// A pen and a stage for tests that run a real server: real sync clients over real WebSockets.
// The pen draws one shape; the stage only stays connected, as the Mac page does. The sync
// library's own socket adapter needs a browser, so this bridges a plain WebSocket to the
// client.

import { TLSyncClient } from '@tldraw/sync-core'
import { atom, createTLSchema, createTLStore, type TLRecord, type TLStore } from 'tldraw'
import { assert } from '../shared/assert'
import type { Role } from '../shared/constants'
import { ClientSocket } from './simulated_client'

const applied_checks_count_max = 300
const applied_check_interval_ms = 10

type Connected = { store: TLStore; close: () => void }

// One page's connection to a board session, loaded and in sync.
async function client_connect(port: number, role: Role, session: string): Promise<Connected> {
  assert(/^[0-9a-z]{1,16}$/.test(session), 'a board session is an id')
  assert(port > 0, 'a running board has a port')
  const store = createTLStore({ schema: createTLSchema() })
  const query = `role=${role}&sessionId=test-${role}&session=${session}`
  const web_socket = new WebSocket(`ws://127.0.0.1:${port}/sync?${query}`)
  const socket = new ClientSocket(
    (message) => web_socket.send(JSON.stringify(message)),
    () => {},
  )
  web_socket.onmessage = (event) => socket.message_deliver(JSON.parse(String(event.data)) as object)
  web_socket.onopen = () => socket.status_set('online')
  const loaded = Promise.withResolvers<void>()
  const client = new TLSyncClient<TLRecord, TLStore>({
    store,
    socket,
    presence: atom('presence', null),
    didCancel: () => false,
    onLoad: () => loaded.resolve(),
    onSyncError: (reason) => loaded.reject(new Error(reason)),
  })
  await loaded.promise
  return {
    store,
    close: () => {
      client.close()
      web_socket.close()
    },
  }
}

// Draws a square with the given id on the given board session, and returns once `applied` says
// the server has it. `shape` draws that shape instead, such as a pen stroke.
export async function test_pen_draw(
  port: number,
  shape_id: string,
  applied: () => boolean | Promise<boolean>,
  session = 'default',
  shape: TLRecord = square(shape_id),
): Promise<void> {
  assert(shape_id.startsWith('shape:'), 'a shape id has the shape prefix')
  assert(shape.id === shape_id, 'the drawn shape has the id asked for')
  const pen = await client_connect(port, 'draw', session)

  pen.store.put([shape])
  let checks_count = 0

  while (!(await applied())) {
    checks_count += 1
    assert(checks_count < applied_checks_count_max, 'the server applies the shape')
    await Bun.sleep(applied_check_interval_ms)
  }

  pen.close()
}

// Connects a stage to the given board session and returns how to disconnect it. While it is
// connected the board counts a stage as open. It renders nothing: a test that needs an image
// or a draft's picture sends one itself, as the Mac page would.
export async function test_stage_open(port: number, session = 'default'): Promise<() => void> {
  const stage = await client_connect(port, 'stage', session)
  assert(typeof stage.close === 'function', 'a connected stage can be disconnected')
  return stage.close
}

function square(shape_id: string): TLRecord {
  return {
    id: shape_id,
    typeName: 'shape',
    type: 'geo',
    x: 0,
    y: 0,
    rotation: 0,
    index: 'a1',
    parentId: 'page:page',
    isLocked: false,
    opacity: 1,
    meta: {},
    props: {
      w: 10,
      h: 10,
      geo: 'rectangle',
      color: 'black',
      labelColor: 'black',
      fill: 'none',
      dash: 'draw',
      size: 'm',
      font: 'draw',
      align: 'middle',
      verticalAlign: 'middle',
      growY: 0,
      url: '',
      scale: 1,
      richText: { type: 'doc', content: [] },
    },
  } as unknown as TLRecord
}
