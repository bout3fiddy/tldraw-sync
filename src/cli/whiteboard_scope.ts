import path from 'node:path'
import type { Binding } from '../shared/whiteboard'
import { data_directory } from './board_process'
import { private_text } from './whiteboard_file'

// A bound board as a command sees it: its credentials, and the file they were read from, which
// the next command an agent is told to run names again.
export type Scope = { binding: Binding; file: string }

export function binding_headers(binding: Binding) {
  return { authorization: `Bearer ${binding.token}`, 'x-board-owner': binding.owner }
}

export function machine_headers() {
  const key = private_text(path.join(data_directory(), 'whiteboard.key'))
  return { authorization: `Bearer ${key}` }
}
