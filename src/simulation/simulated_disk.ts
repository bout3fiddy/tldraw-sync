// A disk that can fail at the worst moment. Because the real disk replaces files atomically,
// a crash during a write has exactly two outcomes: the old file or the new one. The simulator
// picks "the old one" by throwing before anything is stored, which models the process dying
// between writing the temporary file and renaming it.

import { assert } from '../shared/assert'
import { board_file_names, file_names, type Disk, type FileName } from '../server/storage'

export class SimulatedCrash extends Error {}

export class SimulatedDisk implements Disk {
  private readonly files = new Map<FileName, Uint8Array>()
  write_fault_armed = false
  on_write: (name: FileName, bytes: Uint8Array) => void = () => undefined

  remove_board_files(): void {
    for (const name of board_file_names) this.files.delete(name)
  }

  read(name: FileName): Uint8Array | null {
    assert(file_names.includes(name), 'file name is known')
    const bytes = this.files.get(name)
    // A copy, so that no caller can change what is "on disk" by accident.
    return bytes === undefined ? null : bytes.slice()
  }

  write_atomic(name: FileName, bytes: Uint8Array): void {
    assert(file_names.includes(name), 'file name is known')
    if (this.write_fault_armed) {
      this.write_fault_armed = false
      throw new SimulatedCrash()
    }
    this.files.set(name, bytes.slice())
    this.on_write(name, bytes)
  }
}
