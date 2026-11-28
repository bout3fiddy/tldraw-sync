import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { tailnet_discovery, tailnet_status } from './tailnet'

const ip = '100.65.2.3'
const status = (state = 'Running', ips = [ip], online = true) =>
  JSON.stringify({
    BackendState: state,
    Self: { Online: online, TailscaleIPs: ips },
  })
const interfaces: typeof os.networkInterfaces = () => ({
  utun4: [
    {
      family: 'IPv4',
      address: ip,
      internal: false,
      cidr: `${ip}/32`,
      netmask: '255.255.255.255',
      mac: '00:00:00:00:00:00',
    },
  ],
})

test('only a running, online, locally bound self IPv4 can be advertised', async () => {
  for (const invalid of [
    null,
    '',
    'null',
    '{',
    '{}',
    status('Stopped'),
    status('Running', [ip], false),
    status('Running', ['100.65.2.4']),
    status('Running', ['localhost', '::1']),
    JSON.stringify({ BackendState: 'Running', Peer: { someone: { TailscaleIPs: [ip] } } }),
  ]) {
    const discover = tailnet_discovery(async () => invalid, interfaces)
    expect(await discover()).toBeNull()
  }

  const discover = tailnet_discovery(async () => status('Running', ['fd7a::1', ip]), interfaces)
  expect(await discover()).toBe(ip)

  const local_only = async () => JSON.stringify({ BackendState: 'Running', TailscaleIPs: [ip] })
  expect(await tailnet_discovery(local_only, interfaces)()).toBe(ip)
})

test('sheets share one probe; overflow falls back, and VPN changes need no restart', async () => {
  let now = 0
  let calls = 0
  let resolve_status!: (output: string | null) => void
  const read = () =>
    new Promise<string | null>((resolve) => {
      calls += 1
      resolve_status = resolve
    })
  const discover = tailnet_discovery(read, interfaces, () => now)
  const first = Array.from({ length: 8 }, discover)
  expect(await discover()).toBeNull()
  expect(calls).toBe(1)
  resolve_status(status())
  expect(await Promise.all(first)).toEqual(Array(8).fill(ip))

  now = 2999
  expect(await discover()).toBe(ip)
  expect(calls).toBe(1)

  for (const [output, expected] of [
    [status('Stopped'), null],
    [status(), ip],
  ] as const) {
    now += 3000
    const next = discover()
    resolve_status(output)
    expect(await next).toBe(expected)
    expect(await discover()).toBe(expected)
  }

  expect(calls).toBe(3)
})

test('the local command is self-only, output-bounded and killed on timeout', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'board-status-'))
  const file = path.join(dir, 'Local client')
  const script = (body: string) => fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o700 })

  try {
    expect(await tailnet_status(file)).toBeNull()
    script(`[ "$*" = 'status --json --peers=false' ] && printf active`)
    expect(await tailnet_status(file)).toBe('active')
    script('printf partial; exit 1')
    expect(await tailnet_status(file)).toBeNull()
    script('exec /usr/bin/head -c 65537 /dev/zero')
    expect(await tailnet_status(file)).toBeNull()
    script('exec /bin/sleep 30')
    expect(await tailnet_status(file)).toBeNull()
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
