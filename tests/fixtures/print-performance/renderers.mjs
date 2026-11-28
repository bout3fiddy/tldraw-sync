// How the benchmark drives one way of showing the agent's drawing. Each renderer opens a page
// on a board, shows a view and says where a shape of the scene is on the screen; the benchmark
// measures and checks the pixels itself, the same way for every renderer. A new renderer, such
// as native shapes on a canvas shared with the person's ink, needs only an entry here.
//
// A view names the scene state it shows, the board's key for it, and the presses that choose
// it on the board's own switch. Renderers that run on the board press them; the control
// applies the state directly.
//
//   name       how the renderer is chosen: `--renderer svg-print,native-control`
//   boundary   what one sample measures, for the report
//   open       a page showing the view at rest, the whole scene in view
//   show       one view chosen; resolves with { ms, shapes_count, long_task_ms_max }
//   show_quick several views chosen without waiting; measured until the last is shown
//   shape_box  where a shape of the scene is on screen, or null when it is not shown

const frames_count_max = 3600

// In the page, before anything loads: the time of each press and the long tasks.
function page_probe() {
  const bench = { pressed: 0, long_tasks: [] }
  window.__bench = bench
  addEventListener('pointerdown', (event) => (bench.pressed = event.timeStamp), true)
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      bench.long_tasks.push({ start: entry.startTime, ms: entry.duration })
    }

    bench.long_tasks.splice(0, Math.max(0, bench.long_tasks.length - 4096))
  }).observe({ type: 'longtask', buffered: false })
}

// In the page: from the last press until the board's print names the view and is drawn, plus
// the two frames that commit and paint it. Polled once a frame, so a sample is frame-aligned.
function print_wait([view, frames_max]) {
  const bench = window.__bench
  bench.wait = new Promise((resolve, reject) => {
    let frames = 0
    const check = () => {
      const region = document.querySelector('[aria-label="Agent print"]')
      const shown =
        region?.getAttribute('data-view') === view && region.getAttribute('aria-busy') === 'false'

      if (!shown) {
        frames += 1

        if (frames > frames_max) reject(new Error(`View ${view} was not shown.`))
        else requestAnimationFrame(check)

        return
      }

      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const tasks = bench.long_tasks.filter((task) => task.start >= bench.pressed)
          resolve({
            ms: performance.now() - bench.pressed,
            long_task_ms_max: Math.max(0, ...tasks.map((task) => task.ms)),
            shapes_count: region.querySelectorAll('.print__shape:not([data-state="ghost"])').length,
            failed: Number(region.getAttribute('data-failed')),
          })
        }),
      )
    }
    requestAnimationFrame(check)
  })
}

async function press(page, step) {
  const role = step.kind === 'switch' ? 'switch' : 'radio'
  await page.getByRole(role, { name: step.name, exact: true }).click()
}

async function board_action(page, name) {
  await page.getByRole('button', { name: 'Boards', exact: true }).click()
  const rail = page.getByRole('complementary', { name: 'Boards' })
  const active = rail.locator('li', { has: page.locator('[aria-current="page"]') })
  await active.getByRole('button', { name: /^Actions for / }).click()
  await active.getByRole('menuitem', { name, exact: true }).click()
}

// The board's own draw page, with its print of the agent's drawing under the person's ink:
// each top-level shape exported by tldraw as SVG (`src/client/print_engine`).
export const svg_print = {
  name: 'svg-print',
  boundary: 'press event time on the board switch to the print naming the view, plus two frames',

  async open(browser, board, viewport) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)))
    await page.addInitScript(page_probe)
    const started = Date.now()
    await page.goto(board.url)
    await page.waitForFunction(
      (view) => {
        const region = document.querySelector('[aria-label="Agent print"]')
        return (
          region?.getAttribute('data-view') === view && region.getAttribute('aria-busy') === 'false'
        )
      },
      String(board.revision),
      { polling: 'raf' },
    )
    const startup_ms = Date.now() - started

    // Fit through the board's own camera action. Older release baselines offer it in the key.
    const legacy_fit = page.locator('.key [data-layer="agent"]')

    if (await legacy_fit.isVisible()) {
      await legacy_fit.click()
    } else {
      await board_action(page, 'Fit agent drawing')
    }

    await page.waitForTimeout(600)
    const controls = page.getByRole('radiogroup').first()

    // Oversized scenes offer the same controls on demand. This is before the first sample.
    if (!(await controls.isVisible())) await board_action(page, 'Drawing views…')

    await controls.waitFor()
    return { page, errors, startup_ms }
  },

  async show(session, view) {
    await session.page.evaluate(print_wait, [view.key, frames_count_max])

    for (const step of view.press) await press(session.page, step)

    const sample = await session.page.evaluate(() => window.__bench.wait)

    if (sample.failed !== 0) throw new Error(`View ${view.key}: ${sample.failed} shapes failed.`)

    return sample
  },

  async show_quick(session, views) {
    const last = views[views.length - 1]
    await session.page.evaluate(print_wait, [last.key, frames_count_max])

    for (const view of views) {
      for (const step of view.press) await press(session.page, step)
    }

    return session.page.evaluate(() => window.__bench.wait)
  },

  async shape_box(session, scene_id) {
    const selector = `.print__shape[data-print-shape="shape:scene-${scene_id}"]`
    const shape = session.page.locator(`${selector}:not([data-state="ghost"])`)

    if ((await shape.count()) === 0) return null

    return shape.first().boundingBox()
  },

  async close(session) {
    await session.page.close()
  },
}

// tldraw itself showing the same records natively in one kept, read-only editor, a view
// applied as one change to its store (`control/main.tsx`). It is not the board, and is not
// driven by the switch: it measures what native display of the agent's shapes costs.
export const native_control = {
  name: 'native-control',
  boundary: 'one store change applying the view to the painted page, plus two frames',

  async open(browser, board, viewport) {
    const page = await browser.newPage({ viewport })
    const errors = []
    page.on('pageerror', (error) => errors.push(error.message.slice(0, 200)))
    const started = Date.now()
    await page.goto(board.control_url)
    await page.waitForFunction(() => window.__control !== undefined)
    await page.evaluate(
      ([text, revision]) => window.__control.start(text, revision),
      [board.scene_text, board.revision],
    )
    return { page, errors, startup_ms: Date.now() - started }
  },

  show(session, view) {
    return session.page.evaluate((state) => window.__control.show(state), view.state)
  },

  // Each view but the last is applied without waiting for it to be painted.
  async show_quick(session, views) {
    for (const view of views.slice(0, -1)) {
      await session.page.evaluate((state) => window.__control.apply(state), view.state)
    }

    return native_control.show(session, views[views.length - 1])
  },

  shape_box(session, scene_id) {
    return session.page.evaluate((id) => window.__control.shape_box(id), scene_id)
  },

  async close(session) {
    await session.page.close()
  },
}

export const renderers = [svg_print, native_control]
