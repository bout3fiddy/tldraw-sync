// A pen for tests that run a real server: a real sync client over a real WebSocket, drawing
// one shape. The sync library's own socket adapter needs a browser, so this bridges a plain
// WebSocket to the client.

import { TLSyncClient } from '@tldraw/sync-core'
import { atom, createTLSchema, createTLStore, type TLRecord, type TLStore } from 'tldraw'
import { assert } from '../shared/assert'
import { ClientSocket } from './simulated_client'

const applied_checks_count_max = 300
const applied_check_interval_ms = 10

// Draws a square with the given id on the given board session, and returns once `applied` says
// the server has it.
export async function test_pen_draw(
  port: number,
  shape_id: string,
  applied: () => boolean | Promise<boolean>,
  session = 'default',
): Promise<void> {
  assert(shape_id.startsWith('shape:'), 'a shape id has the shape prefix')
  assert(/^[0-9a-z]{1,16}$/.test(session), 'a board session is an id')
  const store = createTLStore({ schema: createTLSchema() })
  const query = `role=draw&sessionId=test-pen&session=${session}`
  const web_socket = new WebSocket(`ws://127.0.0.1:${port}/sync?${query}`)
  const socket = new ClientSocket((message) => web_socket.send(JSON.stringify(message)), () => {})
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

  store.put([square(shape_id)])
  let checks_count = 0
  while (!(await applied())) {
    checks_count += 1
    assert(checks_count < applied_checks_count_max, 'the server applies the shape')
    await Bun.sleep(applied_check_interval_ms)
  }
  client.close()
  web_socket.close()
}

function square(shape_id: string): TLRecord {
  return {
    id: shape_id, typeName: 'shape', type: 'geo', x: 0, y: 0, rotation: 0, index: 'a1',
    parentId: 'page:page', isLocked: false, opacity: 1, meta: {},
    props: {
      w: 10, h: 10, geo: 'rectangle', color: 'black', labelColor: 'black', fill: 'none',
      dash: 'draw', size: 'm', font: 'draw', align: 'middle', verticalAlign: 'middle',
      growY: 0, url: '', scale: 1, richText: { type: 'doc', content: [] },
    },
  } as unknown as TLRecord
}
