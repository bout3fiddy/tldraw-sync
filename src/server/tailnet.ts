// Only a stage opening its pairing sheet needs this hint. Ask the local client about itself;
// never look up a peer, resolve a name from the request, or pass status output to a logger.
import { execFile } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { isIPv4 } from 'node:net'
import { networkInterfaces } from 'node:os'
import { assert } from '../shared/assert'

const status_timeout_ms = 1000
const status_bytes_max = 64 * 1024
const cache_ttl_ms = 3000
const waiters_max = 8
const self_ips_max = 16 // Normally one IPv4 and one IPv6.

// Both Mac app editions ship a CLI in the app bundle. Also support the standard CLI installs,
// without searching the daemon's working directory, user-supplied PATH, or invoking a shell.
const mac_clients = [
  '/Applications/Tailscale.app/Contents/MacOS/Tailscale',
  '/opt/homebrew/bin/tailscale',
  '/usr/local/bin/tailscale',
] as const

function mac_status(): Promise<string | null> {
  if (process.platform === 'darwin') {
    for (const file of mac_clients) {
      try {
        accessSync(file, constants.X_OK)
      } catch {
        continue
      }

      return tailnet_status(file)
    }
  }

  return Promise.resolve(null)
}

export function tailnet_status(file: string): Promise<string | null> {
  assert(file.startsWith('/'), 'only a local absolute executable path is used')
  assert(status_timeout_ms < cache_ttl_ms, 'a slow probe cannot consume every refresh')

  return new Promise((resolve) => {
    execFile(
      file,
      ['status', '--json', '--peers=false'],
      {
        env: { HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, TAILSCALE_BE_CLI: '1' },
        encoding: 'utf8',
        timeout: status_timeout_ms,
        maxBuffer: status_bytes_max,
        killSignal: 'SIGKILL',
      },
      (error, stdout) => resolve(error ? null : stdout),
    )
  })
}

function tailnet_ipv4(status: string | null, interfaces: typeof networkInterfaces): string | null {
  if (!status || Buffer.byteLength(status) > status_bytes_max) return null

  let parsed: {
    BackendState?: unknown
    TailscaleIPs?: unknown
    Self?: { Online?: unknown; TailscaleIPs?: unknown }
  } | null

  try {
    parsed = JSON.parse(status)
  } catch {
    return null
  }

  if (parsed?.BackendState !== 'Running' || parsed.Self?.Online === false) return null

  // TailscaleIPs at the status root describes this machine too, never another peer.
  const ips = parsed.TailscaleIPs ?? parsed.Self?.TailscaleIPs

  if (!Array.isArray(ips) || ips.length > self_ips_max) return null

  // A userspace-only VPN address won't accept a connection to our ordinary IPv4 listener.
  let local: ReturnType<typeof networkInterfaces>

  try {
    local = interfaces()
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error)) throw error

    return null
  }

  for (const entries of Object.values(local)) {
    for (const entry of entries ?? []) {
      if (!entry.internal && isIPv4(entry.address) && ips.includes(entry.address)) {
        return entry.address
      }
    }
  }

  return null
}

export function tailnet_discovery(
  read = mac_status,
  interfaces = networkInterfaces,
  now_ms = () => performance.now(),
): () => Promise<string | null> {
  let expires_ms = -Infinity
  let address: string | null = null
  let probing: Promise<string | null> | null = null
  let waiters = 0

  return async () => {
    if (now_ms() < expires_ms) return address

    if (waiters === waiters_max) return null // Extra sheets can still use the local QR.

    if (!probing) {
      probing = read()
        .then((status) => {
          address = tailnet_ipv4(status, interfaces)
          expires_ms = now_ms() + cache_ttl_ms
          return address
        })
        .finally(() => {
          probing = null
        })
    }

    waiters += 1
    assert(waiters <= waiters_max, 'a status probe has bounded subscribers')

    try {
      return await probing
    } finally {
      assert(waiters > 0, 'a returning sheet was counted')
      waiters -= 1
    }
  }
}
