// The board's chat: a column of the person's messages and the agent's answers on the vellum,
// at a reading measure, with the composer at its foot. Each message keeps a receipt of what
// became of it, and an answer that drew on the Agent canvas offers a way there. Words go
// alone unless the sketch is added, and then the sketch goes as it is at that moment.

import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react'
import type { Role } from '../shared/constants'
import type { Chat } from './chat_state'
import { composer_ready, type Composer } from './chat_state'
import {
  receipt_ended,
  receipt_label,
  receipt_trouble,
  thread_entries,
  thread_working,
  type Answer,
  type Entry,
  type Mine,
} from './chat_thread'
import { ChatComposer } from './chat_composer'
import { icon_open, icon_retry, icon_sketch_small } from './icons'

export type ChatProps = {
  role: Role
  title: string
  linked: boolean
  online: boolean
  paired: boolean
  chat: Chat
  read_seq: number | null
  composer: Composer
  composer_props: Parameters<typeof composer_ready>[1]
  onOpenCanvas: () => void
}

const time_format = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' })
const day_format = new Intl.DateTimeFormat('en-GB', {
  weekday: 'long',
  day: 'numeric',
  month: 'long',
})
const time_of = (ms: number) => time_format.format(ms)
const day_of = (ms: number) => day_format.format(ms)

export function ChatPane(props: ChatProps) {
  const { chat, composer } = props
  const entries = thread_entries(chat.items ?? [], composer.locals, props.read_seq)
  const working = chat.items === null ? null : thread_working(chat.items)
  const log = use_follow(entries.length)
  const root = use_keyboard_inset()
  return (
    <div className="chat" ref={root}>
      <header className="chat__head">
        <h1 className="chat__title">{props.title}</h1>
        <p className="chat__standing" data-trouble={standing_trouble(props)}>
          {standing_text(props)}
        </p>
      </header>
      <div className="chat__scroll" ref={log}>
        <div className="chat__lane">
          <ChatScope title={props.title} />
          <ol className="chat__log" role="log" aria-label="Messages">
            {entries.map((entry, index) => (
              <ChatEntry key={entry.key} entry={entry} before={entries[index - 1]} {...props} />
            ))}
          </ol>
          {working !== null && (
            <p className="chat__working" role="status">
              <span className="chat__mark" aria-hidden="true" />
              {receipt_label(working.state)}
              {working.status !== null && <span className="chat__status">{working.status}</span>}
            </p>
          )}
        </div>
      </div>
      <ChatComposer {...props} />
    </div>
  )
}

// Keeps the newest message in sight as messages arrive, unless the reader has scrolled back.
function use_follow(count: number) {
  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  useEffect(() => {
    const element = scroller.current

    if (element === null) return

    const scrolled = () => {
      const gap = element.scrollHeight - element.scrollTop - element.clientHeight
      following.current = gap < 48
    }
    element.addEventListener('scroll', scrolled, { passive: true })
    return () => element.removeEventListener('scroll', scrolled)
  }, [])
  useLayoutEffect(() => {
    const element = scroller.current

    if (element !== null && following.current) element.scrollTop = element.scrollHeight
  }, [count])
  return scroller
}

// The part of the screen a keyboard leaves in sight, told to the chat as the inset under it,
// so the composer stays above the keyboard. The page's own size, and every view, stay as
// they were.
function use_keyboard_inset() {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const viewport = window.visualViewport
    const element = root.current

    if (!viewport || !element) return

    const update = () => {
      const hidden_px = window.innerHeight - viewport.offsetTop - viewport.height
      element.style.setProperty('--keyboard-inset', `${Math.max(0, Math.round(hidden_px))}px`)
    }
    update()
    viewport.addEventListener('resize', update)
    viewport.addEventListener('scroll', update)
    return () => {
      viewport.removeEventListener('resize', update)
      viewport.removeEventListener('scroll', update)
    }
  }, [])
  return root
}

function standing_text({ linked, online, paired, chat, role }: ChatProps): string {
  if (!linked) return 'No agent linked. Link one on the Mac to chat here.'

  if (!online) return role === 'draw' ? 'Lost the Mac' : 'The board has stopped'

  if (chat.denied) return 'This pairing has ended. Scan the Mac stage QR again.'

  if (!paired) {
    return role === 'draw'
      ? 'Not paired. Scan the Mac stage QR to read and send.'
      : 'Reload this page to open the chat.'
  }

  return 'Agent linked on this Mac. This chat is for this board only.'
}

const standing_trouble = (props: ChatProps) =>
  !props.linked || !props.online || !props.paired || props.chat.denied

function ChatScope({ title }: { title: string }) {
  return (
    <div className="chat__scope">
      <p className="chat__scope-title">This chat belongs to this board.</p>
      <p className="chat__scope-text">
        The agent linked to {title} answers here, with this board’s sketch and Agent canvas in
        reach. Other boards keep their own chats. Delete the board and its chat goes with it.
      </p>
    </div>
  )
}

type EntryProps = ChatProps & { entry: Entry; before: Entry | undefined }

function ChatEntry({ entry, before, ...props }: EntryProps) {
  const day = day_of(entry.at_ms)
  const new_day = before === undefined || day_of(before.at_ms) !== day
  return (
    <>
      {new_day && (
        <li className="chat__day">
          <span>{day}</span>
        </li>
      )}
      {entry.type === 'mine' ? (
        <MineMessage mine={entry} {...props} />
      ) : (
        <AnswerMessage answer={entry} onOpenCanvas={props.onOpenCanvas} />
      )}
    </>
  )
}

function MineMessage({ mine, composer, composer_props }: ChatProps & { mine: Mine }) {
  const retry_possible =
    mine.state === 'unconfirmed' &&
    !composer.busy &&
    composer_props.online &&
    composer_props.token !== null
  const words = mine.include_sketch ? '' : 'Words only · '
  return (
    <li className="chat__mine" data-state={mine.state} data-local={mine.local}>
      <div className="chat__slip">
        {mine.include_sketch && <SketchSent mine={mine} />}
        {mine.text !== null && <p className="chat__words">{mine.text}</p>}
      </div>
      <div className="chat__receipt" data-trouble={receipt_trouble(mine.state)}>
        <span className="chat__mark" data-ended={receipt_ended(mine.state)} aria-hidden="true" />
        <span>
          {words}
          {receipt_label(mine.state)} · {time_of(mine.at_ms)}
        </span>
        {mine.state === 'unconfirmed' && (
          <button
            type="button"
            className="chat__again"
            disabled={!retry_possible}
            onClick={composer.retry}
          >
            {icon_retry}
            Send again
          </button>
        )}
      </div>
      {mine.detail !== null && <p className="chat__detail">{mine.detail}</p>}
    </li>
  )
}

function SketchSent({ mine }: { mine: Mine }) {
  const shapes = mine.shapes_count
  const count = shapes === null ? '' : `${shapes} ${shapes === 1 ? 'shape' : 'shapes'} · `
  const hash = mine.sketch_hash?.slice(0, 6) ?? ''
  return (
    <div className="chat__sketch">
      <span className="chat__picture" aria-hidden="true">
        {icon_sketch_small}
      </span>
      <span className="chat__sketch-text">
        <span className="chat__sketch-title">Sketch, as it was</span>
        <span className="chat__sketch-meta">
          {count}
          {hash}
        </span>
      </span>
    </div>
  )
}

type AnswerProps = { answer: Answer; onOpenCanvas: () => void }

function AnswerMessage({ answer, onOpenCanvas }: AnswerProps) {
  const open_key = (event: KeyboardEvent<HTMLButtonElement>) => event.stopPropagation()
  return (
    <li className="chat__answer" data-failed={answer.failed} data-unread={answer.unread}>
      <p className="chat__from">
        <span className="chat__who">Agent</span>
        <span className="chat__when">{time_of(answer.at_ms)}</span>
        {answer.unread && <span className="chat__new">New</span>}
      </p>
      <p className="chat__words chat__words--answer">{answer.text}</p>
      {answer.canvas_revision !== null && (
        <div className="chat__canvas">
          <span className="chat__mark" data-ended="true" aria-hidden="true" />
          <span className="chat__canvas-text">
            Drew on the Agent canvas · revision {answer.canvas_revision}
          </span>
          <button type="button" className="chat__open" onClick={onOpenCanvas} onKeyDown={open_key}>
            Open
            {icon_open}
          </button>
        </div>
      )}
    </li>
  )
}
