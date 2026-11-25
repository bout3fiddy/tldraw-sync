import path from 'node:path'
import type { Binding, Layer } from '../shared/whiteboard'
import { data_directory } from './board_process'
import { private_text } from './whiteboard_file'

export type Scope = { binding: Binding; layer: Layer; file: string }

export function binding_headers(binding: Binding) {
  return { authorization: `Bearer ${binding.token}`, 'x-board-owner': binding.owner }
}

export function machine_headers() {
  const key = private_text(path.join(data_directory(), 'whiteboard.key'))
  return { authorization: `Bearer ${key}` }
}
