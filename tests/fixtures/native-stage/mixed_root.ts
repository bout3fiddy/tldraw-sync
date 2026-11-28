// A stopped data directory holding every kind of board a native stage meets, made with the
// board's own code: the original board with a sketch, an Agent canvas and an answered chat; a
// linked legacy board (`legacy_board.ts`); an unlinked legacy board whose Agent canvas has
// Drawing views; a native board with one agent revision in its journal; and a listed board
// never opened, with no folder. No board is assumed linked.

import fs from 'node:fs'
import path from 'node:path'
import type { TLRecord } from '@tldraw/tlschema'
import { board_default_id } from '../../../src/shared/board_session'
import { time_real } from '../../../src/shared/time'
import { BoardRegistry, type LinkResult } from '../../../src/server/board_registry'
import { disk_open, session_storage } from '../../../src/server/storage'
import { sketch_stroke } from '../../../src/simulation/test_sketch'
import {
  canvas_publish,
  chat_write,
  legacy_board_write,
  sketch_write,
} from '../native-rehearsal/legacy_board'

export const native_owner = 'native-host'

export type MixedRoot = {
  readonly linked: string
  readonly unlinked: string
  readonly native: string
  readonly empty: string
}

export async function mixed_root_write(root: string): Promise<MixedRoot> {
  if (!path.isAbsolute(root)) throw new Error('Name an absolute directory.')

  const { session: linked } = legacy_board_write(root, 'static', 'answered')
  sketch_write(disk_open(root))
  const environment = {
    time: time_real,
    disk: disk_open(root),
    ...session_storage(root),
    id_create: id_counter(),
  }
  const creating = BoardRegistry.open(environment)
  const [unlinked, native, empty] = [
    created(creating.create(null)),
    created(creating.link(native_owner, true)),
    created(creating.create(null)),
  ]
  creating.close()
  sketch_write(environment.disk_board(unlinked))
  sketch_write(environment.disk_board(native))

  const registry = BoardRegistry.open(environment)

  try {
    canvas_publish(registry, board_default_id, 'static')
    chat_write(registry, board_default_id, 'answered')
    canvas_publish(registry, unlinked, 'interactive')
    await native_edit(registry, native)
  } finally {
    registry.close()
  }

  // A served root keeps its daemon's log beside the boards.
  fs.writeFileSync(path.join(root, 'server.log'), 'board started\n')
  return { linked, unlinked, native, empty }
}

// One agent revision on the native board: a moon beside the sun, which the iPad can undo.
async function native_edit(registry: BoardRegistry, session: string): Promise<void> {
  const lookup = registry.board(session)

  if (lookup.kind !== 'board' || lookup.board.native === null) {
    throw new Error('the fixture native board did not open')
  }

  const scene = lookup.board.native
  const moon = {
    ...sketch_stroke(
      'shape:new-moon',
      80,
      0,
      [
        [0, 0],
        [3, 3],
        [6, 0],
      ],
      'yellow',
    ),
    index: 'a3',
  } as TLRecord
  const outcome = await scene.edit({
    request_id: 'fixture-moon-1',
    base_sequence: scene.scene_read().base_sequence,
    request: { adds: [moon as never], updates: [], deletes: [] },
  })

  if (outcome.kind !== 'written') throw new Error(`the fixture edit was ${outcome.kind}`)
}

function created(result: LinkResult): string {
  if (result.kind !== 'created') throw new Error('the fixture board was not made')

  return result.session.id
}

// Sixteen hex digits, different each call, the same each run.
function id_counter(): () => string {
  let next = 0x5eed0000

  return () => {
    next += 1
    return next.toString(16).padStart(16, '0')
  }
}
