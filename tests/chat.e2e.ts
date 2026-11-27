// A board's chat in real browsers, on a disposable linked board: the iPad and the Mac stage,
// words alone and the sketch, the agent's answers under what they answer, news that waits on
// the Chat tab of its own board only, history that outlives a reload, and recovery from a lost
// reply, an old Mac and a refusal without a word lost or a request sent twice. A page that is
// not paired reads nothing. The board's earlier note, bell and Side by side are gone.
//
// Run: bun run build && npx playwright test tests/chat.e2e.ts

import { expect, test, type Page, type Request } from '@playwright/test'
import {
  action_ms,
  add_sketch,
  answers,
  board_linked,
  chat_open,
  chat_send,
  chat_tab,
  draw,
  field,
  mine,
  navigation_ms,
  retired_controls,
  send_button,
  sketch_open,
  step,
  step_long_ms,
  stroke,
  type Cli,
  type Linked,
} from './whiteboard_board'

// Disposable pairing material belongs neither in traces nor in screenshots.
test.use({ trace: 'off', actionTimeout: action_ms, navigationTimeout: navigation_ms })

type Json = Record<string, any>

const unread = (page: Page) => page.getByTestId('chat-unread')

function ack(bound: Cli, event: string, state: string, ...rest: string[]) {
  expect(bound('ack', '--event', event, '--state', state, ...rest).status).toBe('success')
}

// The pairing a Mac stage is handed for its own board, asked for as the stage asks.
async function pad_token({ stage, origin, session }: Linked): Promise<string> {
  const url = `${origin}/api/whiteboard/stage?session=${session}`
  const response = await stage.request.get(url, { headers: { 'x-board-stage': 'chat' } })
  expect(response.status()).toBe(200)
  return String(((await response.json()) as Json).token)
}

test('the iPad and Mac share one board chat: words alone, the sketch, answers and news', async ({
  browser,
}) => {
  await board_linked(browser, async (board) => {
    await step('Sketchboard, Agent canvas and Chat, and none of the old controls', () =>
      tabs_only(board),
    )
    await step('the sketch goes only when added; words alone name none', () => sends(board))
    await step('answers are read where seen and news where not, across reloads', () => news(board))
    await step(
      'another board keeps its own chat, draft and news',
      () => boards_apart(board),
      step_long_ms,
    )
    await step('the Mac stage reads the same chat, sends, and keeps rendering the sketch', () =>
      stage_chat(board),
    )
    await step('a page that is not paired reads nothing of the chat', () => unpaired(board))
  })
})

// A preference saved for the retired Side by side view opens the Sketchboard and is written
// over. Chat is one tab, at the top right, on a 44px target.
async function tabs_only({ ipad }: Linked) {
  await ipad.evaluate(() => localStorage.setItem('tldraw-sync.view.draw', 'side'))
  await ipad.reload()
  await expect(ipad.getByRole('tab')).toHaveText(['Sketchboard', 'Agent canvas', 'Chat'])
  await expect(ipad.getByRole('tab', { name: 'Sketchboard' })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  expect(await ipad.evaluate(() => localStorage.getItem('tldraw-sync.view.draw'))).toBe('sketch')
  await expect(retired_controls(ipad)).toHaveCount(0)
  const box = (await chat_tab(ipad).boundingBox())!
  expect(box.height).toBeGreaterThanOrEqual(44)
  expect(ipad.viewportSize()!.width - (box.x + box.width)).toBeLessThanOrEqual(24)
  expect(box.y).toBeLessThanOrEqual(24)
}

const event_posted = (page: Page) =>
  page.waitForRequest((request: Request) => request.url().includes('/api/whiteboard/event/v2'))

async function sends({ ipad, bound, cli, session }: Linked) {
  await draw(ipad)
  await expect.poll(() => cli('status', '--session', session).shapes_count).toBe(1)
  const hash = cli('status', '--session', session).document_hash as string

  // With the sketch: the card says what goes, the request names the sketch as it is now.
  await chat_open(ipad)
  await add_sketch(ipad).click()
  await expect(ipad.locator('.chat__attached')).toContainText('Sketch, as it is now')
  await expect(ipad.locator('.chat__attached')).toContainText('1 shape')
  await ipad.getByRole('button', { name: 'Remove sketch' }).click()
  await expect(add_sketch(ipad)).toHaveAttribute('aria-pressed', 'false')
  const drawn = event_posted(ipad)
  await chat_send(ipad, 'Tidy this up.', true)
  expect((await drawn).postDataJSON()).toMatchObject({ include_sketch: true, sketch_hash: hash })
  await expect(mine(ipad, 'Tidy this up.').locator('.chat__sketch')).toContainText('1 shape')

  // Words alone: no sketch in the request, and none in what the host is handed.
  const alone = event_posted(ipad)
  await chat_send(ipad, 'And words alone.')
  expect((await alone).postDataJSON()).not.toHaveProperty('sketch_hash')
  await expect(mine(ipad, 'And words alone.').locator('.chat__receipt')).toContainText(
    'Words only · Queued on the Mac',
  )
  await expect(mine(ipad, 'And words alone.').locator('.chat__sketch')).toHaveCount(0)
  const events = bound('poll').events as Json[]
  expect(events).toMatchObject([
    { include_sketch: true, sketch_hash: hash, text: 'Tidy this up.' },
    { include_sketch: false, text: 'And words alone.' },
  ])
}

async function news({ ipad, bound }: Linked) {
  const [first, second] = bound('poll').events as Json[]

  // Seen as it arrives: the chat is on screen, so the answer is read.
  for (const state of ['received', 'working']) ack(bound, first!.id, state)

  ack(bound, first!.id, 'updated', '--message', 'Tidied: three boxes, two arrows.')
  await expect(answers(ipad, 'Tidied: three boxes')).toBeVisible()
  await expect(unread(ipad)).toHaveCount(0)

  // Not on screen: the answer waits as news on the Chat tab, through other views and a
  // reload. A status line is not news.
  await sketch_open(ipad)
  ack(bound, second!.id, 'received')
  ack(bound, second!.id, 'working', '--message', 'Thinking it over')
  await expect(ipad.getByRole('tab', { name: 'Sketchboard' })).toBeVisible()
  await expect(unread(ipad)).toHaveCount(0)
  ack(bound, second!.id, 'failed', '--message', 'I could not tell which box you meant.')
  await expect(unread(ipad)).toBeVisible()
  await expect(chat_tab(ipad)).toHaveAccessibleName(/^Chat\W+1 new answer$/)
  await ipad.getByRole('tab', { name: 'Agent canvas' }).click()
  await expect(unread(ipad)).toBeVisible()
  await ipad.reload()
  await expect(unread(ipad)).toBeVisible()

  // Read once the chat is opened; the history is all there, in order, after a reload too.
  await chat_open(ipad)
  await expect(unread(ipad)).toHaveCount(0)
  const failed = answers(ipad, 'I could not tell which box you meant.')
  await expect(failed).toHaveAttribute('data-failed', 'true')
  await expect(mine(ipad, 'And words alone.').locator('.chat__receipt')).toContainText('Failed')
  await ipad.reload()
  await expect(chat_tab(ipad)).toHaveAttribute('aria-selected', 'true')
  await expect(unread(ipad)).toHaveCount(0)
  await expect(ipad.locator('.chat__log > li:not(.chat__day)')).toHaveText([
    /Tidy this up\./,
    /Tidied: three boxes/,
    /And words alone\./,
    /I could not tell/,
  ])
  await expect(answers(ipad, 'Thinking it over')).toHaveCount(0)
}

// Each board has its own chat, draft and news. An answer on this board while another is shown
// is news here only. The other board, with no agent linked, says so and sends nothing.
async function boards_apart({ ipad, bound, cli, session }: Linked) {
  const boards = ipad.getByRole('complementary', { name: 'Boards' })
  const board_open = async (id: string) => {
    await ipad.getByRole('button', { name: 'Boards', exact: true }).click()
    await boards.locator(`a[href="/s/${id}/draw"]`).click()
    await expect(ipad).toHaveURL(new RegExp(`/s/${id}/draw$`))
  }
  await chat_send(ipad, 'Is the gateway the slow part?')
  const asked = (bound('poll').events as Json[]).at(-1)!
  await field(ipad).fill('A draft for this board')

  const other = String(cli('session-create').session.id)
  await board_open(other)
  await chat_open(ipad)
  await expect(ipad.locator('.chat__standing')).toContainText('No agent linked')
  await expect(field(ipad)).toBeDisabled()
  await expect(field(ipad)).toHaveValue('')
  await expect(ipad.locator('.chat__mine, .chat__answer')).toHaveCount(0)
  ack(bound, asked.id, 'received')
  ack(bound, asked.id, 'updated', '--message', 'Yes, by about a second.')
  await sketch_open(ipad)
  await ipad.waitForTimeout(2_000)
  await expect(unread(ipad)).toHaveCount(0)

  await board_open(session)
  await expect(unread(ipad)).toBeVisible()
  await chat_open(ipad)
  await expect(answers(ipad, 'Yes, by about a second.')).toBeVisible()
  await expect(field(ipad)).toHaveValue('A draft for this board')
  await field(ipad).fill('')
  await sketch_open(ipad)
}

// The stage is paired with its own board on the Mac. It shows what the iPad sent and what the
// agent answered, sends words alone, and renders the sketch for the agent while it does.
async function stage_chat({ stage, ipad, bound, cli, session }: Linked) {
  await chat_open(stage)
  await expect(stage.locator('.chat__standing')).toContainText('Agent linked on this Mac')
  await expect(answers(stage, 'Tidied: three boxes')).toBeVisible()
  await expect(mine(stage, 'Is the gateway the slow part?')).toBeVisible()
  await expect(add_sketch(stage)).toBeEnabled()
  await chat_send(stage, 'From the Mac: and the retry?')
  const sent = (bound('poll').events as Json[]).at(-1)!
  expect(sent).toMatchObject({ include_sketch: false, text: 'From the Mac: and the retry?' })
  await chat_open(ipad)
  await expect(mine(ipad, 'From the Mac: and the retry?')).toBeVisible()
  await sketch_open(ipad)

  // A new stroke on the iPad is rendered by the stage, though it shows the chat.
  await stroke(ipad, { x: 320, y: 420 }, { x: 25, y: -10 })
  await expect.poll(() => cli('status', '--session', session).shapes_count).toBe(2)
  await expect.poll(() => cli('fetch', '--session', session).status).toBe('success')
  await sketch_open(stage)
}

async function unpaired(board: Linked) {
  const { ipad, origin, session } = board
  const token = await pad_token(board)
  const stranger = await ipad.context().browser()!.newPage({ viewport: ipad.viewportSize()! })

  try {
    await stranger.goto(`${origin}/s/${session}/draw`)
    await chat_open(stranger)
    await expect(stranger.locator('.chat__standing')).toContainText('Not paired')
    await expect(stranger.locator('.chat__mine, .chat__answer')).toHaveCount(0)
    await expect(send_button(stranger)).toBeDisabled()
    await stranger.waitForTimeout(2_000)
    await expect(stranger.locator('body')).not.toContainText('Tidy this up.')
    const chat_url = `${origin}/api/whiteboard/chat?session=${session}`
    expect((await stranger.request.get(chat_url)).status()).toBe(403)

    // The pairing is what reads it, and what the stage holds is that pairing.
    const paired = { authorization: `Bearer ${token}` }
    const read = await stranger.request.get(chat_url, { headers: paired })
    expect(read.status()).toBe(200)
    expect(JSON.stringify(await read.json())).toContain('Tidy this up.')
    const status = await stranger.request.get(`${origin}/api/cleaned/status?session=${session}`)
    expect(await status.text()).not.toContain('Tidied')
  } finally {
    await stranger.close()
  }
}

test('a lost reply, an old Mac and a refusal keep every word and send nothing twice', async ({
  browser,
}) => {
  await board_linked(browser, async (board) => {
    await step('a reply lost after the Mac saved the message: shown once', () => lost(board))
    await step('never reached the Mac: kept through a reload, sent again once', () =>
      unreached(board),
    )
    await step('an old Mac and a refusal: the words come back', () => refused(board))
  })
})

// The Mac has the message but its reply is lost. The board's chat shows it, once, and the
// field is free again; nothing is waiting to be sent.
async function lost({ ipad, bound }: Linked) {
  await chat_open(ipad)
  await ipad.route(
    '**/api/whiteboard/event/v2?*',
    async (route) => {
      expect((await route.fetch()).ok()).toBe(true)
      await route.abort('failed')
    },
    { times: 1 },
  )
  await field(ipad).fill('Save first, then ack.')
  await send_button(ipad).click()
  await expect(mine(ipad, 'Save first, then ack.')).toHaveCount(1)
  await expect(mine(ipad, 'Save first, then ack.')).toHaveAttribute('data-local', 'false')
  await expect(mine(ipad, 'Save first, then ack.')).toContainText('Queued on the Mac')
  await expect(ipad.locator('.chat__caption')).not.toContainText('waiting above')
  expect(bound('poll').events).toHaveLength(1)
  await ipad.reload()
  await expect(mine(ipad, 'Save first, then ack.')).toHaveCount(1)
  expect(bound('poll').events).toHaveLength(1)
}

// The message never reached the Mac. It waits above the field as not confirmed, through a
// reload, while a new draft is written; Send waits for it. Send again sends it once.
async function unreached({ ipad, bound }: Linked) {
  const words = 'Redraw it that way.'
  await ipad.route('**/api/whiteboard/event/v2?*', (route) => route.abort('failed'), { times: 1 })
  await field(ipad).fill(words)
  await send_button(ipad).click()
  const waiting = mine(ipad, words)
  await expect(waiting).toHaveAttribute('data-local', 'true')
  await expect(waiting).toContainText('Not confirmed')
  await expect(field(ipad)).toHaveValue('')
  await expect(ipad.locator('.chat__caption')).toContainText('One message is waiting above.')
  await field(ipad).fill('And label the retry with its timeout')
  await expect(send_button(ipad)).toBeDisabled()
  expect(bound('poll').events).toHaveLength(1)

  await ipad.reload()
  await expect(mine(ipad, words)).toHaveAttribute('data-local', 'true')
  await expect(field(ipad)).toHaveValue('And label the retry with its timeout')
  await mine(ipad, words).getByRole('button', { name: 'Send again' }).click()
  await expect(mine(ipad, words)).toHaveAttribute('data-local', 'false')
  await expect(mine(ipad, words)).toHaveCount(1)
  await expect.poll(() => bound('poll').events.length).toBe(2)
  await expect(send_button(ipad)).toBeEnabled()
  await mine(ipad, words).getByRole('button', { name: 'Send again' }).waitFor({ state: 'detached' })
  expect((bound('poll').events as Json[]).filter((event) => event.text === words)).toHaveLength(1)
}

// An old Mac is found before a byte of the message is sent; a refusal from the Mac hands the
// words back into the field, before what was written since.
async function refused({ ipad, bound }: Linked) {
  const words = 'And label the retry with its timeout'
  await ipad.route('**/api/status?*', (route) => route.fulfill({ json: { protocol: 3 } }), {
    times: 1,
  })
  await send_button(ipad).click()
  await expect(mine(ipad, words)).toHaveAttribute('data-local', 'true')
  await expect(mine(ipad, words)).toContainText('Upgrade and restart the Mac board')
  expect(bound('poll').events).toHaveLength(2)

  await field(ipad).fill('Then tell me.')
  await ipad.route(
    '**/api/whiteboard/event/v2?*',
    (route) =>
      route.fulfill({
        status: 409,
        json: { code: 'events_full', message: 'The agent queue is full.' },
      }),
    { times: 1 },
  )
  await mine(ipad, words).getByRole('button', { name: 'Send again' }).click()
  await expect(ipad.locator('.chat__caption')).toContainText('Not sent: The agent queue is full.')
  await expect(field(ipad)).toHaveValue(`${words}\n\nThen tell me.`)
  await expect(mine(ipad, words)).toHaveCount(0)
  expect(bound('poll').events).toHaveLength(2)

  // Sent from the field, the words go once.
  await send_button(ipad).click()
  await expect(field(ipad)).toHaveValue('')
  await expect.poll(() => bound('poll').events.length).toBe(3)
}
