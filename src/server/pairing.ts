// Pairing is how the iPad finds the Mac without anyone typing an address: the Mac shows a QR
// code for its own draw page, in the terminal and on the stage.

import { networkInterfaces } from 'node:os'
import qrcode from 'qrcode-generator'
import { assert } from '../shared/assert'
import { path_draw } from '../shared/constants'

// Rows of the QR code, top to bottom. Each row is a string of '1' (dark) and '0' (light).
export type Pairing = { readonly url: string; readonly modules: readonly string[] }

const modules_count_min = 21
const modules_count_max = 177
const quiet_zone_modules = 4

export function pairing_create(host: string, port: number): Pairing {
  assert(host.length > 0, 'host is not empty')
  assert(Number.isInteger(port), 'port is an integer')
  assert(port > 0, 'port is positive')
  assert(port < 65536, 'port fits sixteen bits')

  return pairing_encode(`http://${host}:${port}${path_draw}`)
}

// The pairing for one board's draw page: the same host and port, that board's path. The QR
// code of the default board is the one it always was.
export function pairing_board(pairing: Pairing, draw_path: string): Pairing {
  assert(pairing.url.endsWith(path_draw), 'a pairing leads to a draw page')
  assert(draw_path.startsWith('/'), 'a draw path is absolute')
  if (draw_path === path_draw) return pairing

  const origin = pairing.url.slice(0, pairing.url.length - path_draw.length)
  return pairing_encode(`${origin}${draw_path}`)
}

function pairing_encode(url: string): Pairing {
  assert(url.startsWith('http://'), 'a pairing is a plain-HTTP address')
  const code = qrcode(0, 'M')
  code.addData(url)
  code.make()

  const count = code.getModuleCount()
  assert(count >= modules_count_min, 'QR code is at least version 1')
  assert(count <= modules_count_max, 'QR code is at most version 40')

  const modules: string[] = []
  for (let row = 0; row < count; row += 1) {
    let line = ''
    for (let column = 0; column < count; column += 1) {
      line += code.isDark(row, column) ? '1' : '0'
    }
    modules.push(line)
  }
  assert(modules.length === count, 'QR code is square')
  return { url, modules }
}

// The Bonjour name survives a change of network or IP address, so a Home Screen bookmark
// made once keeps working. The IP address is the fallback when the name cannot be read.
export function pairing_host(): string {
  const host_bonjour = host_bonjour_read()
  if (host_bonjour !== null) {
    assert(host_bonjour.endsWith('.local'), 'a Bonjour host is in the local domain')
    return host_bonjour
  }

  for (const addresses of Object.values(networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        assert(address.address.length > 0, 'an interface address is not empty')
        return address.address
      }
    }
  }
  return 'localhost'
}

function host_bonjour_read(): string | null {
  if (process.platform !== 'darwin') return null
  const result = Bun.spawnSync(['scutil', '--get', 'LocalHostName'], { timeout: 2000 })
  if (result.exitCode !== 0) return null
  const name = result.stdout.toString().trim()
  if (!/^[A-Za-z0-9-]{1,63}$/.test(name)) return null
  assert(!name.includes('.'), 'a Bonjour name is a single label')
  return `${name}.local`
}

// Two module rows per terminal line, drawn with half blocks. Colours are set explicitly to
// black on white so the code scans in a dark terminal as well as a light one.
export function pairing_terminal(pairing: Pairing): string {
  assert(pairing.modules.length >= modules_count_min, 'QR code is at least version 1')
  assert(pairing.modules.length <= modules_count_max, 'QR code is at most version 40')
  const size = pairing.modules.length + quiet_zone_modules * 2
  const dark = (row: number, column: number): boolean => {
    const line = pairing.modules[row - quiet_zone_modules]
    return line !== undefined && line[column - quiet_zone_modules] === '1'
  }

  const lines: string[] = []
  for (let row = 0; row < size; row += 2) {
    let line = ''
    for (let column = 0; column < size; column += 1) {
      const top = dark(row, column)
      const bottom = dark(row + 1, column)
      if (top) {
        line += bottom ? '█' : '▀'
      } else {
        line += bottom ? '▄' : ' '
      }
    }
    lines.push(`  \x1b[30;47m${line}\x1b[0m`)
  }
  assert(lines.length === Math.ceil(size / 2), 'every module row is drawn')
  return lines.join('\n')
}
