// A registry of board sessions on simulated disks, for tests and simulations: one disk for the
// data directory, one more for each board opened, and ids from a counter so that every run
// makes the same ids in the same order.

import { assert } from '../shared/assert'
import { board_default_id, board_id_pattern } from '../shared/board_session'
import type { Time } from '../shared/time'
import type { RegistryEnvironment } from '../server/board_registry'
import { SimulatedDisk } from './simulated_disk'

export type SimulatedRegistryEnvironment = RegistryEnvironment & {
  readonly disk: SimulatedDisk
  readonly disks: Map<string, SimulatedDisk>
}

// Disks survive a restart: open the registry again on the same environment.
export function registry_environment_simulated(
  time: Time,
  disk: SimulatedDisk = new SimulatedDisk(),
): SimulatedRegistryEnvironment {
  const disks = new Map<string, SimulatedDisk>()
  let ids_count = 0
  return {
    time,
    disk,
    disks,
    disk_board(id) {
      assert(board_id_pattern.test(id), 'a board disk is for a valid id')
      const existing = disks.get(id)

      if (existing !== undefined) return existing

      const created = new SimulatedDisk()
      disks.set(id, created)
      return created
    },
    disk_exists: (id) => disks.has(id),
    disk_remove(id) {
      if (id === board_default_id) disk.remove_board_files()
      else disks.delete(id)
    },
    id_create() {
      ids_count += 1
      const id = ids_count.toString(16).padStart(16, 'a')
      assert(board_id_pattern.test(id), 'a counted id is sixteen hex digits')
      return id
    },
  }
}
