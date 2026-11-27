// Opt-in benchmark of how long a person waits to see the agent's drawing change on a dense
// interactive scene, for any way of showing it (`renderers.mjs`). It builds the app, starts a
// disposable board through the real command line, publishes a synthetic scene (`scene.mjs`)
// and drives headless Chromium at 1440x900. Nothing touches a live board or real drawings.
//
// Each sample runs to the renderer reporting the view drawn, plus two frames: the frame that
// commits it and the one that paints it. Each renderer names where its samples start. Every
// view is then checked on screen, the same way for every renderer: the shape only that view
// shows is in the page with ink on it, the other views' shapes are not, and nothing failed.
// No timing is a pass or a fail: a run fails only when what is painted is wrong.
//
// The dense run: the 772-element scene of 120 states. Each of six disjoint views of 8 to 200
// top-level shapes from cold, then each again, a change of one minor control (a few shapes),
// and on a fresh page a quick run of four choices. The sweep (`--sweep`): for each size, a
// small view at rest, then a view of that many shapes it does not share, cold; a toggle adding
// 8 shapes to it; and revisits; with heap and long tasks.
//
// Run: node tests/fixtures/print-performance/prepare-bench.mjs [--rounds 1]
//        [--renderer svg-print,native-control] [--sweep 100,200,400,600,751] [--dense]
//        [--out dir] [--reference dir] [--skip-build] [--profile]
// A sweep runs alone unless `--dense` asks for the dense run as well.
// `--out` keeps one screenshot per dense view; `--reference` compares them with an earlier
// run's of the same renderer. `--profile` builds without minifying and prints where the first
// cold switch to the largest dense view spends its time, as sampled by Chromium's profiler.

import { chromium } from '@playwright/test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { control_build, control_serve } from './native.mjs'
import { renderers } from './renderers.mjs'
import {
  lens_labels,
  mode_labels,
  modes,
  option_sizes,
  scene_dense,
  scene_elements_count,
  scene_sweep,
  sentinel_id,
  sweep_roots_count_max,
} from './scene.mjs'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const viewport = { width: 1440, height: 900 }
const command_ms = 30_000
const action_ms = 60_000
const rounds_max = 10
const sweep_default = [100, 200, 400, 600, sweep_roots_count_max]

// A shape is painted when its box holds this much ink: each pixel counts by how far it is
// from white, so a thin outline far zoomed out still counts, while the white sheet counts
// nothing and one of its pale dots well under this.
const ink_min = 4

// A pixel differs from the reference when a channel moves by more than this, and a view
// matches while at most this many of its pixels differ: anti-aliasing, not a missing shape.
const pixel_channel_tolerance = 48
const pixels_differ_max = 40

function options_read(argv) {
  const options = {
    rounds: 1,
    out: null,
    reference: null,
    build: true,
    profile: false,
    renderers: ['svg-print'],
    sweep: null,
    dense: null,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const value = () => argv[(index += 1)] ?? ''

    if (name === '--skip-build') options.build = false
    else if (name === '--dense') options.dense = true
    else if (name === '--profile') options.profile = true
    else if (name === '--rounds') options.rounds = Number(value())
    else if (name === '--out') options.out = path.resolve(value())
    else if (name === '--reference') options.reference = path.resolve(value())
    else if (name === '--renderer') options.renderers = value().split(',')
    else if (name === '--sweep') {
      const sizes = argv[index + 1]
      options.sweep = sweep_read(sizes)

      if (sizes !== undefined && /^\d+(,\d+)*$/.test(sizes)) index += 1
    } else throw new Error(`Unknown option ${name}.`)
  }

  if (!Number.isSafeInteger(options.rounds) || options.rounds < 1) {
    throw new Error('--rounds takes a whole number of at least 1.')
  }

  if (options.rounds > rounds_max) throw new Error(`--rounds is at most ${rounds_max}.`)

  // A sweep alone is asked for unless the dense run is asked for too.
  options.dense ??= options.sweep === null

  for (const name of options.renderers) {
    if (!renderers.some((renderer) => renderer.name === name)) {
      throw new Error(`No renderer ${name}: ${renderers.map((each) => each.name).join(', ')}.`)
    }
  }

  return options
}

// The sizes of a sweep, or the default sizes when none follow the option.
function sweep_read(text) {
  if (text === undefined || !/^\d+(,\d+)*$/.test(text)) return sweep_default

  const counts = text.split(',').map(Number)

  for (const count of counts) {
    if (count < 1 || count > sweep_roots_count_max) {
      throw new Error(`A sweep size is 1 to ${sweep_roots_count_max}.`)
    }
  }

  return counts
}

function run(argv) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: repo,
    timeout: command_ms * 2,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })

  if (result.status !== 0) {
    const tail = (result.stderr ?? '').slice(-800)
    throw new Error(`${path.basename(argv[0])} exited ${result.status}: ${tail}`)
  }

  return result.stdout
}

// The board's own command line on a temporary data directory, answering in JSON.
function cli(root, ...args) {
  const result = spawnSync(process.env.BUN ?? 'bun', ['src/cli/main.ts', ...args, '--json'], {
    cwd: repo,
    env: { ...process.env, BOARD_DATA_DIR: root, PATH: `${root}:${process.env.PATH}` },
    timeout: command_ms,
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })

  if (typeof result.stdout !== 'string' || result.stdout.trim() === '') {
    throw new Error(`tldraw-sync ${args[0]} exited ${result.status} and printed nothing.`)
  }

  return JSON.parse(result.stdout)
}

function protocol_read() {
  const text = fs.readFileSync(path.join(repo, 'src/shared/whiteboard.ts'), 'utf8')
  const found = /export const whiteboard_protocol = (\d+)/.exec(text)

  if (found === null) throw new Error('The whiteboard protocol was not found.')

  return found[1]
}

// Links a disposable board. Its address and binding stay in this process.
function board_link(root) {
  const file = path.join(root, 'binding.json')
  const opener = path.join(root, process.platform === 'darwin' ? 'open' : 'xdg-open')
  fs.writeFileSync(opener, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  const link = ['--protocol', protocol_read(), '--owner', 'bench', '--out', file]
  const linked = cli(root, 'whiteboard-link', ...link)

  if (linked.status !== 'success') throw new Error(`The board did not link: ${linked.code}.`)

  const origin = new URL(linked.stage_url).origin
  const session = String(linked.session)
  const bound = (action, ...args) => cli(root, `whiteboard-${action}`, '--binding', file, ...args)
  return { root, origin, session, bound, url: `${origin}/s/${session}/draw`, revision: 0 }
}

// Publishes a scene as the board's next revision, and reads it back as the page does.
async function board_publish(board, scene, summary) {
  const snap = board.bound('snapshot', '--out', path.join(board.root, `snap${board.revision}`))
  const draft = JSON.parse(fs.readFileSync(snap.scene_path, 'utf8'))
  Object.assign(draft, { agent: 'bench', summary }, scene)
  fs.writeFileSync(snap.scene_path, JSON.stringify(draft))
  const published = board.bound('publish', '--file', snap.scene_path)

  if (published.code !== 'published') throw new Error(`Not published: ${published.code}.`)

  const query = `session=${board.session}&interactive=1`
  const response = await fetch(`${board.origin}/api/cleaned/view.json?${query}`)

  if (!response.ok) throw new Error(`The scene was not served: ${response.status}.`)

  return { ...board, revision: published.revision, scene_text: await response.text() }
}

// The dense scene's views: each mode at rest elsewhere, and one minor change of the largest.
function dense_views(revision) {
  const key = (state) => {
    const rest = state.mode === 'm0' && state.step === 's0' && state.lens === 'l0'
    return rest ? String(revision) : `${revision} ${state.mode}/${state.step}/${state.lens}`
  }
  const views = modes.map((mode, index) => {
    const state = { mode, step: 's0', lens: 'l0' }
    return {
      name: mode,
      state,
      key: key(state),
      press: [{ kind: 'radio', name: mode_labels[index] }],
      sentinel: sentinel_id(index),
      absent: modes.flatMap((_, other) => (other === index ? [] : [sentinel_id(other)])),
    }
  })
  const lens = { mode: 'm3', step: 's0', lens: 'l1' }
  const minor = { ...views[3], name: 'm3 lens 2', state: lens, key: key(lens) }
  minor.press = [{ kind: 'radio', name: lens_labels[1] }]
  const back = { ...views[3], name: 'm3', press: [{ kind: 'radio', name: lens_labels[0] }] }
  return { views, minor, back }
}

// The sweep scene's views: small at rest, large, and large with its extra notes.
function sweep_views(revision) {
  return {
    small: {
      name: 'small',
      state: { mode: 'small', extra: 'off' },
      key: String(revision),
      press: [{ kind: 'radio', name: 'Small' }],
      sentinel: 's-box0',
      absent: ['l-box0'],
    },
    large: {
      name: 'large',
      state: { mode: 'large', extra: 'off' },
      key: `${revision} large/off`,
      press: [{ kind: 'radio', name: 'Large' }],
      sentinel: 'l-box0',
      absent: ['s-box0', 'extra0'],
    },
    extra: {
      name: 'large and extra',
      state: { mode: 'large', extra: 'on' },
      key: `${revision} large/on`,
      press: [{ kind: 'switch', name: 'Extra' }],
      sentinel: 'extra0',
      absent: ['s-box0'],
    },
  }
}

// The view shown is the one chosen: its own shape is painted, and no other view's is there.
async function painted_check(renderer, session, view) {
  const box = await renderer.shape_box(session, view.sentinel)

  if (box === null || box.width <= 0 || box.height <= 0) {
    throw new Error(`${renderer.name}: the shape of ${view.name} is not on screen.`)
  }

  for (const id of view.absent) {
    if ((await renderer.shape_box(session, id)) !== null) {
      throw new Error(`${renderer.name}: ${view.name} still shows ${id}.`)
    }
  }

  const png = await session.page.screenshot({ scale: 'css', animations: 'disabled' })
  const ink = await session.page.evaluate(ink_count, [png.toString('base64'), box])

  if (ink < ink_min) throw new Error(`${renderer.name}: ${view.name} is not painted (${ink}).`)

  return png
}

// In the page: the ink in a screenshot's box, in any colour, as whole pixels' worth.
async function ink_count([base64, box]) {
  const image = new Image()
  image.src = `data:image/png;base64,${base64}`
  await image.decode()
  const canvas = document.createElement('canvas')
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const context = canvas.getContext('2d', { willReadFrequently: true })
  context.drawImage(image, 0, 0)
  const left = Math.max(0, Math.floor(box.x))
  const top = Math.max(0, Math.floor(box.y))
  const width = Math.max(1, Math.min(canvas.width - left, Math.ceil(box.width)))
  const height = Math.max(1, Math.min(canvas.height - top, Math.ceil(box.height)))
  const data = context.getImageData(left, top, width, height).data
  let ink = 0

  for (let index = 0; index < data.length; index += 4) {
    const [r, g, b] = [data[index], data[index + 1], data[index + 2]]
    ink += 1 - Math.min(r, g, b) / 255
  }

  return Math.round(ink * 10) / 10
}

// In the page: how many pixels differ between two screenshots of the same size.
async function pixels_differ([first, second, tolerance]) {
  const decode = async (base64) => {
    const image = new Image()
    image.src = `data:image/png;base64,${base64}`
    await image.decode()
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    const context = canvas.getContext('2d', { willReadFrequently: true })
    context.drawImage(image, 0, 0)
    return context.getImageData(0, 0, canvas.width, canvas.height)
  }
  const [a, b] = await Promise.all([decode(first), decode(second)])

  if (a.width !== b.width || a.height !== b.height) return a.width * a.height

  let count = 0

  for (let index = 0; index < a.data.length; index += 4) {
    const channels = [0, 1, 2].map((offset) => {
      return Math.abs(a.data[index + offset] - b.data[index + offset])
    })

    if (Math.max(...channels) > tolerance) count += 1
  }

  return count
}

// What the page costs while nobody touches it: main-thread task time per second, the script
// heap and the document's nodes, read by Chromium over two quiet seconds.
async function idle_cost(page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  const read = async () => {
    const { metrics } = await session.send('Performance.getMetrics')
    return Object.fromEntries(metrics.map((metric) => [metric.name, metric.value]))
  }
  const quiet_ms = 2000
  const before = await read()
  await page.waitForTimeout(quiet_ms)
  const after = await read()
  await session.detach()

  // TaskDuration is in seconds: seconds per quiet millisecond are milliseconds per second.
  const task_ms_per_s = ((after.TaskDuration - before.TaskDuration) * 1e6) / quiet_ms
  return {
    task_ms_per_s: Math.round(task_ms_per_s * 10) / 10,
    heap_mb: Math.round(after.JSHeapUsedSize / 2 ** 20),
    nodes: after.Nodes,
  }
}

async function profile_start(page) {
  const session = await page.context().newCDPSession(page)
  await session.send('Profiler.enable')
  await session.send('Profiler.setSamplingInterval', { interval: 200 })
  await session.send('Profiler.start')
  return session
}

// Self and inclusive time by function, the largest first.
async function profile_stop(session) {
  const { profile } = await session.send('Profiler.stop')
  await session.detach()
  const by_id = new Map(profile.nodes.map((node) => [node.id, node]))
  const parents = new Map()
  const deltas = profile.timeDeltas
  const self = new Map()
  const inclusive = new Map()

  for (const node of profile.nodes) {
    for (const child of node.children ?? []) parents.set(child, node.id)
  }

  for (let index = 0; index < profile.samples.length; index += 1) {
    const ms = (deltas[index + 1] ?? 0) / 1000
    const frame = by_id.get(profile.samples[index]).callFrame
    const file = frame.url.split('/').pop()
    const name = `${frame.functionName || '(anonymous)'} ${file}:${frame.lineNumber + 1}`
    self.set(name, (self.get(name) ?? 0) + ms)
    const seen = new Set()

    // Each function counted once per sample it is anywhere on the stack of.
    for (let id = profile.samples[index]; id !== undefined; id = parents.get(id)) {
      const caller = by_id.get(id).callFrame.functionName

      if (caller === '' || seen.has(caller)) continue

      seen.add(caller)
      inclusive.set(caller, (inclusive.get(caller) ?? 0) + ms)
    }
  }

  const top = (map, count) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, count)
      .map(([name, ms]) => `${ms.toFixed(1)} ${name}`)
  const total_ms = Math.round((profile.endTime - profile.startTime) / 1000)
  return { total_ms, self: top(self, 30), inclusive: top(inclusive, 60) }
}

function stats(samples) {
  if (samples.length === 0) return null

  const sorted = samples.map((sample) => sample.ms).sort((a, b) => a - b)
  const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))]
  const round_ms = (value) => Math.round(value * 10) / 10
  return {
    count: sorted.length,
    median_ms: round_ms(at(0.5)),
    p90_ms: round_ms(at(0.9)),
    max_ms: round_ms(sorted[sorted.length - 1]),
    long_task_ms_max: round_ms(Math.max(...samples.map((sample) => sample.long_task_ms_max))),
    samples_ms: samples.map((sample) => Math.round(sample.ms)),
  }
}

// One dense round on a fresh page: each view once from cold, each again, then one minor
// change of the largest view. Screenshots of each view are kept from the first round.
async function dense_round(browser, renderer, board, keep, profile) {
  const session = await renderer.open(browser, board, viewport)
  const { views, minor, back } = dense_views(board.revision)
  const result = { startup_ms: session.startup_ms, cold: [], warm: [], minor: [], pictures: {} }
  const counts = new Map()

  try {
    result.idle_rest = keep ? await idle_cost(session.page) : null
    counts.set(0, (await renderer.show(session, views[0])).shapes_count)

    for (const [index, view] of views.entries()) {
      if (index === 0) continue

      const profiler = profile && index === 3 ? await profile_start(session.page) : null
      const sample = await renderer.show(session, view)

      if (profiler !== null) result.profile = await profile_stop(profiler)

      result.cold.push({ view: view.name, ...sample })
      counts.set(index, sample.shapes_count)
      const png = await painted_check(renderer, session, view)

      if (keep) result.pictures[view.name] = png
    }

    for (const [index, view] of views.entries()) {
      const sample = await renderer.show(session, view)
      result.warm.push({ view: view.name, ...sample })

      if (sample.shapes_count !== counts.get(index)) {
        throw new Error(`${renderer.name}: a revisit of ${view.name} shows other shapes.`)
      }

      const png = await painted_check(renderer, session, view)

      if (keep && index === 0) result.pictures[view.name] = png
    }

    result.idle_all_seen = keep ? await idle_cost(session.page) : null
    await renderer.show(session, views[3])
    result.minor.push({ view: minor.name, ...(await renderer.show(session, minor)) })
    await painted_check(renderer, session, minor)
    await renderer.show(session, back)
  } finally {
    await renderer.close(session)
  }

  result.errors = session.errors
  return result
}

// On a fresh page, so no view is drawn yet: four choices a few milliseconds apart, of which
// the last must be the one painted.
async function dense_rapid(browser, renderer, board) {
  const session = await renderer.open(browser, board, viewport)
  const { views } = dense_views(board.revision)

  try {
    const sample = await renderer.show_quick(
      session,
      [1, 4, 5, 2].map((index) => views[index]),
    )
    await painted_check(renderer, session, views[2])
    return { view: 'quick run to m2', ...sample, errors: session.errors }
  } finally {
    await renderer.close(session)
  }
}

async function dense(browser, renderer, board, options) {
  const rounds = []
  const rapid = []

  for (let index = 0; index < options.rounds; index += 1) {
    const profile = options.profile && index === 0
    rounds.push(await dense_round(browser, renderer, board, index === 0, profile))
    rapid.push(await dense_rapid(browser, renderer, board))
  }

  const errors = [...rounds, ...rapid].flatMap((each) => each.errors)

  if (errors.length > 0) throw new Error(`${renderer.name}: the page reported ${errors[0]}`)

  const first = rounds[0]
  return {
    renderer: renderer.name,
    boundary: renderer.boundary,
    views_shapes: first.cold.map((sample) => [sample.view, sample.shapes_count]),
    startup_ms: rounds.map((each) => each.startup_ms),
    cold: stats(rounds.flatMap((each) => each.cold)),
    warm: stats(rounds.flatMap((each) => each.warm)),
    minor: stats(rounds.flatMap((each) => each.minor)),
    rapid: stats(rapid),
    idle: { rest: first.idle_rest, all_seen: first.idle_all_seen },
    profile: first.profile,
    pictures: first.pictures,
  }
}

// One sweep size on a fresh page: the large view cold, its extra notes, then revisits.
async function sweep_round(browser, renderer, board, keep) {
  const session = await renderer.open(browser, board, viewport)
  const views = sweep_views(board.revision)
  const result = { cold: [], sparse: [], warm: [] }

  try {
    const cold = await renderer.show(session, views.large)
    await painted_check(renderer, session, views.large)
    result.cold.push(cold)
    result.shapes_count = cold.shapes_count
    result.sparse.push(await renderer.show(session, views.extra))
    await painted_check(renderer, session, views.extra)
    const back = { ...views.large, press: views.extra.press }
    result.warm.push(await renderer.show(session, back))
    result.warm.push(await renderer.show(session, views.small))
    await painted_check(renderer, session, views.small)
    result.warm.push(await renderer.show(session, views.large))
    result.idle = keep ? await idle_cost(session.page) : null
  } finally {
    await renderer.close(session)
  }

  if (session.errors.length > 0) {
    throw new Error(`${renderer.name}: the page reported ${session.errors[0]}`)
  }

  return result
}

async function sweep(browser, chosen, board, counts, rounds) {
  const sizes = []

  for (const roots_count of counts) {
    board = await board_publish(board, scene_sweep(roots_count), 'A sweep of the print.')

    for (const renderer of chosen) {
      const runs = []

      for (let index = 0; index < rounds; index += 1) {
        runs.push(await sweep_round(browser, renderer, board, index === 0))
      }

      sizes.push({
        renderer: renderer.name,
        roots_count,
        shapes_count: runs[0].shapes_count,
        cold: stats(runs.flatMap((each) => each.cold)),
        sparse: stats(runs.flatMap((each) => each.sparse)),
        warm: stats(runs.flatMap((each) => each.warm)),
        idle: runs[0].idle,
      })
    }
  }

  const slopes = Object.fromEntries(
    chosen.map((renderer) => {
      const points = sizes.filter((size) => size.renderer === renderer.name)
      return [renderer.name, slope(points.map((size) => [size.shapes_count, size.cold.median_ms]))]
    }),
  )
  return { sizes, cold_ms_per_shape: slopes }
}

// The least-squares slope of y on x, in y's units per x.
function slope(points) {
  if (points.length < 2) return null

  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length
  const x_mean = mean(points.map(([x]) => x))
  const y_mean = mean(points.map(([, y]) => y))
  const top = points.reduce((sum, [x, y]) => sum + (x - x_mean) * (y - y_mean), 0)
  const bottom = points.reduce((sum, [x]) => sum + (x - x_mean) ** 2, 0)
  return bottom === 0 ? null : Math.round((top / bottom) * 1000) / 1000
}

async function pictures_keep(browser, report, options) {
  for (const run of report.dense) {
    const pictures = run.pictures
    delete run.pictures

    if (options.out !== null) {
      fs.mkdirSync(options.out, { recursive: true })

      for (const [view, png] of Object.entries(pictures)) {
        fs.writeFileSync(path.join(options.out, `${run.renderer}-${view}.png`), png)
      }
    }

    if (options.reference === null) continue

    const page = await browser.newPage({ viewport })
    run.pixels_differ = {}

    try {
      for (const [view, png] of Object.entries(pictures)) {
        const file = path.join(options.reference, `${run.renderer}-${view}.png`)

        if (!fs.existsSync(file)) throw new Error(`No reference picture for ${view}.`)

        const base64 = fs.readFileSync(file).toString('base64')
        const differ = await page.evaluate(pixels_differ, [
          base64,
          png.toString('base64'),
          pixel_channel_tolerance,
        ])
        run.pixels_differ[view] = differ

        if (differ > pixels_differ_max) throw new Error(`${view} differs from the reference.`)
      }
    } finally {
      await page.close()
    }
  }
}

async function main() {
  const options = options_read(process.argv.slice(2))
  const chosen = renderers.filter((renderer) => options.renderers.includes(renderer.name))
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'print-bench-')))
  const native = chosen.some((renderer) => renderer.name === 'native-control')

  if (options.build) {
    const minify = options.profile ? ['--minify', 'false'] : []
    run([path.join(repo, 'node_modules/.bin/vite'), 'build', '--logLevel', 'error', ...minify])
  }

  if (native) await control_build(path.join(root, 'control'))

  const control = native ? await control_serve(path.join(root, 'control')) : null
  const browser = await chromium.launch()
  let linked = false

  try {
    let board = { ...board_link(root), control_url: control?.url ?? null }
    linked = true
    board = await board_publish(board, scene_dense(), 'A dense interactive drawing.')
    const report = {
      workload: {
        viewport,
        browser: `chromium ${browser.version()} headless`,
        build: options.profile ? 'vite production, unminified' : 'vite production',
        dense: { elements: scene_elements_count, option_sizes, states: 6 * 4 * 5 },
        rounds: options.rounds,
      },
      dense: [],
    }

    for (const renderer of options.dense ? chosen : []) {
      report.dense.push(await dense(browser, renderer, board, options))
    }

    if (options.sweep !== null) {
      report.sweep = await sweep(browser, chosen, board, options.sweep, options.rounds)
    }

    await pictures_keep(browser, report, options)
    console.log(JSON.stringify(report, null, 2))
  } finally {
    await browser.close()
    control?.stop()

    if (linked) cli(root, 'stop')

    fs.rmSync(root, { recursive: true, force: true })
  }
}

await main()
