import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { assert } from '../shared/assert'
import { board_id_pattern } from '../shared/board_session'
import { credential_pattern, owner_pattern } from '../shared/whiteboard'
import { StorageError, type Disk } from './storage'

// Only the local CLI reads the machine key. Board credentials survive a daemon restart, and
// one board's browser token cannot be promoted to a control token or transferred to another.
export function machine_key(disk: Disk): string {
  let bytes = disk.read('whiteboard.key')

  if (bytes === null) {
    bytes = new TextEncoder().encode(randomBytes(32).toString('hex'))
    disk.write_atomic('whiteboard.key', bytes)
    const written = disk.read('whiteboard.key')
    assert(written !== null && written.length === bytes.length, 'the key was saved whole')
    assert(Buffer.from(bytes).equals(written), 'the issuing key survives restart')
  }

  const key = new TextDecoder().decode(bytes)

  if (!credential_pattern.test(key)) throw new StorageError('Invalid whiteboard machine key.')

  return key
}

export function scoped_key(key: string, scope: 'event' | 'host', session: string, owner: string) {
  assert(credential_pattern.test(key), 'the signing key is complete')
  assert(board_id_pattern.test(session) && owner_pattern.test(owner), 'scope is unambiguous')
  return createHmac('sha256', key).update(`${scope}:${session}:${owner}`).digest('hex')
}

export function authorized(request: Request, expected: string): boolean {
  const supplied = request.headers.get('authorization')?.slice(7) ?? ''

  if (!request.headers.get('authorization')?.startsWith('Bearer ')) return false

  if (!credential_pattern.test(supplied)) return false

  assert(expected.length === supplied.length, 'both credentials have the fixed width')
  return timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
}
