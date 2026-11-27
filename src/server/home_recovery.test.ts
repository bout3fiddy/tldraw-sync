import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sketch_disk, sketch_square } from '../simulation/test_sketch'
import { VirtualTime } from '../simulation/virtual_time'
import { BoardRegistry } from './board_registry'
import { disk_open, session_storage, StorageError } from './storage'

test('restart during legacy root cleanup keeps the registry, siblings and issuing key', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-home-'))
  const disk = disk_open(root)
  const storage = session_storage(root)
  const env = { time: new VirtualTime(), disk, ...storage, id_create: () => '1234567890abcdef' }
  const square = sketch_disk([sketch_square('shape:legacy', 0)]).read('board.snapshot')!

  try {
    disk.write_atomic('board.snapshot', square)
    const registry = BoardRegistry.open(env)
    const linked = registry.link('first-owner')

    if (linked.kind !== 'created') throw new Error('link failed')

    const survivor = linked.session.id
    storage.disk_board(survivor).write_atomic('board.snapshot', square)
    const other = path.join(root, 'unrelated')
    fs.writeFileSync(other, 'keep')
    fs.writeFileSync(path.join(root, 'whiteboard.key'), 'private fixture')
    fs.symlinkSync(other, path.join(root, 'drawing.image.tmp'))
    env.disk_remove = () => {
      fs.unlinkSync(path.join(root, 'board.snapshot'))
      throw new StorageError('interrupted after one unlink')
    }
    expect(() => registry.remove('default')).toThrow('interrupted after one unlink')
    registry.destroy()
    env.disk_remove = storage.disk_remove

    const recovered = BoardRegistry.open(env)
    expect(recovered.list().map((item) => item.id)).toEqual([survivor])
    expect(recovered.owner(survivor)).toBe('first-owner')
    expect(recovered.board('default')).toEqual({ kind: 'not_found' })
    expect(fs.readFileSync(other, 'utf8')).toBe('keep')
    expect(fs.readFileSync(path.join(root, 'whiteboard.key'), 'utf8')).toBe('private fixture')
    expect(fs.readdirSync(root)).not.toContain('drawing.image.tmp')
    const room = recovered.board(survivor)

    if (room.kind !== 'board') throw new Error('surviving board unavailable')

    expect(room.board.shapes().map((shape) => shape.id)).toEqual(['shape:legacy'])
    expect(recovered.remove(survivor)).toBe('removed')
    recovered.close()

    const empty = BoardRegistry.open(env)
    expect(empty.list()).toEqual([])
    expect(empty.open_count()).toBe(0)
    const next = empty.create(null)

    if (next.kind !== 'created') throw new Error('create failed')

    expect(next.session.id).not.toBe(survivor)
    expect(empty.owner(next.session.id)).toBeNull()
    expect(empty.board(survivor)).toEqual({ kind: 'not_found' })
    empty.close()
    const restarted = BoardRegistry.open(env)
    expect(restarted.list()).toEqual([next.session])
    restarted.close()
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
