// The native control's page (`control/`), built by the board's own Vite and React plugin and
// served from loopback by a small static server for as long as the benchmark runs.

import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const control_root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'control')

const content_types = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.woff2', 'font/woff2'],
  ['.woff', 'font/woff'],
  ['.png', 'image/png'],
  ['.json', 'application/json'],
])

export async function control_build(out_directory) {
  await build({
    root: control_root,
    base: './',
    configFile: false,
    logLevel: 'error',
    plugins: [react()],
    build: { outDir: out_directory, emptyOutDir: true, chunkSizeWarningLimit: 8192 },
  })
}

// Serves the built page on loopback. Resolves with its address and a function that stops it.
export function control_serve(out_directory) {
  const root = fs.realpathSync(out_directory)
  const server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://loopback').pathname)
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`)

    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end()
      return
    }

    const type = content_types.get(path.extname(file)) ?? 'application/octet-stream'
    response.writeHead(200, { 'content-type': type })
    fs.createReadStream(file).pipe(response)
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ url: `http://127.0.0.1:${port}/`, stop: () => server.close() })
    })
  })
}
