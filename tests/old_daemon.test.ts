import { expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { whiteboard_protocol } from '../src/shared/whiteboard'

// A disposable status-only daemon that advertises no protocol, as a board from before linked
// whiteboards does. There is deliberately no issuing key. The CLI must explain the upgrade
// before trying to open one or starting another daemon. A daemon one protocol behind is told
// the same.
for (const advertised of [undefined, whiteboard_protocol - 1]) {
  const title = `link detects a live daemon on protocol ${advertised} before touching credentials`
  test(title, async () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'old-board-')))
    const paths: string[] = []
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch(request, server) {
        paths.push(new URL(request.url).pathname)
        return Response.json({
          app: 'tldraw-sync',
          pid: process.pid,
          port: server.port,
          stage_connected: true,
          session: 'default',
          draw_url: '',
          stage_url: '',
          ...(advertised === undefined ? {} : { protocol: advertised }),
        })
      },
    })

    try {
      fs.writeFileSync(
        path.join(dir, 'server.json'),
        JSON.stringify({ pid: process.pid, port: server.port }),
      )
      const out = path.join(dir, 'binding.json')
      const child = Bun.spawn(
        [
          process.execPath,
          'src/cli/main.ts',
          'whiteboard-link',
          '--json',
          '--protocol',
          String(whiteboard_protocol),
          '--owner',
          'test',
          '--out',
          out,
        ],
        {
          env: { ...process.env, BOARD_DATA_DIR: dir },
          stdout: 'pipe',
          timeout: 8000,
        },
      )
      const result = JSON.parse(await new Response(child.stdout).text())
      expect(await child.exited).not.toBe(0)
      expect(result).toMatchObject({ status: 'failure', code: 'upgrade_required' })
      expect(paths.length).toBeGreaterThan(0)
      expect(new Set(paths)).toEqual(new Set(['/api/status']))
      expect(fs.existsSync(out)).toBe(false)
    } finally {
      await server.stop(true)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }, 10000)
}
