// Nobody can point an iPad at a test run, so the QR code is checked the way a camera would
// check it: rasterise it and hand the pixels to an independent decoder.

import { expect, test } from 'bun:test'
import jsQR from 'jsqr'
import { time_real } from '../shared/time'
import { registry_environment_simulated } from '../simulation/simulated_registry'
import { BoardRegistry } from './board_registry'
import { server_start } from './http'
import { pairing_create, pairing_terminal, type Pairing } from './pairing'
import { tailnet_discovery } from './tailnet'

const quiet_zone_modules = 4
const pixels_per_module = 4

function decode(pairing: Pairing): string | null {
  const size = (pairing.modules.length + quiet_zone_modules * 2) * pixels_per_module
  const pixels = new Uint8ClampedArray(size * size * 4).fill(255)
  pairing.modules.forEach((row, module_y) => {
    for (let module_x = 0; module_x < row.length; module_x += 1) {
      if (row[module_x] !== '1') continue

      for (let offset = 0; offset < pixels_per_module * pixels_per_module; offset += 1) {
        const x = (module_x + quiet_zone_modules) * pixels_per_module + (offset % pixels_per_module)
        const y =
          (module_y + quiet_zone_modules) * pixels_per_module +
          Math.floor(offset / pixels_per_module)
        pixels.fill(0, (y * size + x) * 4, (y * size + x) * 4 + 3)
      }
    }
  })
  return jsQR(pixels, size, size)?.data ?? null
}

test('the code scans to the draw page of the given host', () => {
  const pairing = pairing_create('Swadhins-Mac-mini.local', 5173)
  expect(pairing.url).toBe('http://Swadhins-Mac-mini.local:5173/draw')
  expect(decode(pairing)).toBe(pairing.url)
})

test('codes for many hosts and ports all scan', () => {
  const hosts = ['a.local', '192.168.1.20', 'localhost', `${'long-name-'.repeat(6)}mac.local`]

  for (const host of hosts) {
    for (const port of [1, 80, 5173, 65535]) {
      const pairing = pairing_create(host, port)
      expect(decode(pairing)).toBe(`http://${host}:${port}/draw`)
    }
  }
})

test('the code is square and holds only modules', () => {
  const { modules } = pairing_create('a.local', 5173)

  for (const row of modules) {
    expect(row).toHaveLength(modules.length)
    expect(row).toMatch(/^[01]+$/)
  }
})

test('the terminal rendering covers every module row, with a quiet zone', () => {
  const pairing = pairing_create('a.local', 5173)
  const lines = pairing_terminal(pairing).split('\n')
  const size = pairing.modules.length + quiet_zone_modules * 2
  expect(lines).toHaveLength(Math.ceil(size / 2))

  // The first two terminal lines are the top quiet zone: four blank module rows.
  expect(lines[0]).toBe(`  \x1b[30;47m${' '.repeat(size)}\x1b[0m`)
  expect(lines[1]).toBe(lines[0] as string)
})

test('an impossible port is a programmer error', () => {
  expect(() => pairing_create('a.local', 0)).toThrow('port is positive')
  expect(() => pairing_create('a.local', 70000)).toThrow('port fits sixteen bits')
  expect(() => pairing_create('', 5173)).toThrow('host is not empty')
})

const tail_ip = '100.70.1.2'
const qr = { 'x-board-stage': 'qr' }
type Sheet = Pairing & { local?: Pairing }

function stage_fixture(hostname: string, tailnet_address: () => Promise<string | null>) {
  const registry = BoardRegistry.open(registry_environment_simulated(time_real))
  const linked = registry.link('test-owner')

  if (linked.kind !== 'created') throw new Error('Could not create the disposable board.')

  const id = linked.session.id
  const server = server_start({
    registry,
    hostname,
    tailnet_address,
    port: 0,
    pairing: pairing_create('mac.local', 5173),
    machine_key: '01'.repeat(32),
    static_files: new Map([['/index.html', 'unused']]),
    on_fatal: (error) => {
      throw error
    },
  })
  const origin = `http://127.0.0.1:${server.port}`
  const get = (route: string, headers?: Record<string, string>) =>
    fetch(origin + route, { headers })
  const sheet = async (headers: Record<string, string> = qr, session = id) => {
    const response = await get(`/api/pairing?session=${session}`, headers)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toContain('no-store')
    return (await response.json()) as Sheet
  }

  return {
    registry,
    id,
    get,
    sheet,
    port: server.port,
    close() {
      server.stop(true)
      registry.destroy()
    },
  }
}

test('both codes scan to the selected board with the same private pairing', async () => {
  let connected = true
  let now = 0
  const read = async () =>
    JSON.stringify({
      BackendState: connected ? 'Running' : 'Stopped',
      Self: { Online: true, TailscaleIPs: [tail_ip] },
    })
  const discover = tailnet_discovery(
    read,
    () => ({
      tun: [
        { address: tail_ip, internal: false, family: 'IPv4', mac: '', netmask: '', cidr: null },
      ],
    }),
    () => now,
  )
  const board = stage_fixture('0.0.0.0', discover)

  try {
    const sheet = await board.sheet()

    if (!sheet.local) throw new Error('Missing local alternative.')

    const route = `/s/${board.id}/draw`
    let fragment = ''

    for (const [pair, host] of [
      [sheet, tail_ip],
      [sheet.local, 'mac.local'],
    ] as const) {
      const url = `http://${host}:${board.port}${route}`
      expect(pair.url === url).toBe(true)
      const scanned = new URL(decode(pair) ?? 'about:blank')
      expect(scanned.origin + scanned.pathname === url).toBe(true)
      expect(/^#pair=[0-9a-f]{64}$/.test(scanned.hash)).toBe(true)

      if (fragment) expect(scanned.hash === fragment).toBe(true)

      fragment = scanned.hash

      // Address the actual listener over loopback, as if our synthetic host resolved there.
      const headers = { host: scanned.host, authorization: `Bearer ${fragment.slice(6)}` }

      for (const [action, id, code] of [
        ['chat', board.id, 200],
        ['chat', 'default', 403],
        ['poll', board.id, 403],
      ] as const) {
        const response = await board.get(`/api/whiteboard/${action}?session=${id}`, headers)
        expect(response.status).toBe(code)
        await response.arrayBuffer()
      }
    }

    const status = await (await board.get(`/api/status?session=${board.id}`)).json()
    expect(status.stage_url).toBe(`http://localhost:${board.port}/s/${board.id}`)
    connected = false
    now += 3000
    const local = await board.sheet()
    expect(local.local).toBeUndefined()
    expect(decode(local) === sheet.local.url + fragment).toBe(true)
    connected = true
    now += 3000
    expect(decode(await board.sheet()) === sheet.url + fragment).toBe(true)
  } finally {
    board.close()
  }
})

test('public requests cannot probe or pair; a loopback listener stays local', async () => {
  let probes = 0
  const board = stage_fixture('127.0.0.1', async () => {
    probes += 1
    return tail_ip
  })

  try {
    for (const headers of [
      {},
      { ...qr, origin: 'https://elsewhere.example' },
      { ...qr, host: `${tail_ip}:${board.port}` },
    ] as Record<string, string>[]) {
      const pair = await board.sheet(headers)
      expect(pair.local).toBeUndefined()
      expect(decode(pair) === pair.url).toBe(true)
    }

    expect(probes).toBe(0)

    const pair = await board.sheet()
    expect(pair.local).toBeUndefined()
    expect(new URL(pair.url).hostname).toBe('mac.local')
    expect(new URL(decode(pair) ?? 'about:blank').hash.length).toBeGreaterThan(0)
  } finally {
    board.close()
  }
})

test('neither choice issues a credential for an unlinked board', async () => {
  const board = stage_fixture('0.0.0.0', async () => tail_ip)

  try {
    const pair = await board.sheet(qr, 'default')
    if (!pair.local) throw new Error('Missing local alternative.')

    for (const option of [pair, pair.local]) {
      expect(new URL(option.url).pathname).toBe('/s/default/draw')
      expect(decode(option) === option.url).toBe(true)
    }
  } finally {
    board.close()
  }
})

test('removing the board during a probe issues neither QR', async () => {
  const probing = Promise.withResolvers<void>()
  const done = Promise.withResolvers<string | null>()
  const board = stage_fixture('0.0.0.0', () => {
    probing.resolve()
    return done.promise
  })

  try {
    const fetching = board.get(`/api/pairing?session=${board.id}`, qr)
    await probing.promise
    expect(board.registry.remove(board.id)).toBe('removed')
    done.resolve(tail_ip)
    const response = await fetching
    expect(response.status).toBe(404)
    const error = await response.json()
    expect('modules' in error || 'local' in error).toBe(false)
  } finally {
    done.resolve(null)
    board.close()
  }
})
