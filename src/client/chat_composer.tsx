// The composer at the foot of the chat: one plate with an ink edge, the way to add the sketch
// at its left, the field, and send. Opening the chat never raises the keyboard: the field
// waits for a tap of its own. Typing never reaches the canvas shortcuts. The words stay in
// the field while they are on their way, and are cleared only once the Mac has them.

import { useEffect, useState, type KeyboardEvent } from 'react'
import { useValue, type Editor } from 'tldraw'
import type { ChatProps } from './chat_pane'
import { composer_ready } from './chat_state'
import { icon_close_small, icon_send, icon_sketch } from './icons'

export const composer_field_id = 'chat-field'
const caption_id = 'chat-caption'

// The picture of the sketch to be sent is drawn as the sketch is now. A drawing too large to
// show as a small picture shows the glyph instead.
const picture_bytes_max = 2 * 1024 * 1024
const picture_delay_ms = 300

// The Mac cannot be reached: what is kept, and that a retry sends nothing twice.
const lost_text = {
  draw:
    'Lost the Mac. Your words are kept on this iPad. Send again when it is back: ' +
    'nothing is sent twice.',
  stage: 'The board has stopped. Your words are kept here until it is back.',
} as const

export function ChatComposer(props: ChatProps) {
  const { composer, composer_props, role } = props
  const ready = composer_ready(composer, composer_props)
  const send_key = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation()

    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return

    if (event.key !== 'Enter' || event.shiftKey || event.altKey) return

    event.preventDefault()

    if (ready) composer.send()
  }
  return (
    <div className="chat__foot">
      <div className="chat__lane">
        {!props.online && composer_props.linked && (
          <p className="chat__notice" role="status">
            {lost_text[role]}
          </p>
        )}
        <div
          className="chat__composer"
          data-sketch={composer.include_sketch}
          data-ready={ready}
          onKeyDown={(event) => event.stopPropagation()}
        >
          {composer.include_sketch && (
            <SketchToSend editor={composer_props.editor} onRemove={() => composer.attach(false)} />
          )}
          <div className="chat__plate">
            <AddSketch {...props} />
            {/* The field is as tall as its words, to five lines: an unseen copy of the text
                shares its cell and sets the height, so no height is measured or kept. */}
            <span className="chat__field-box">
              <span className="chat__mirror" aria-hidden="true">
                {`${composer.text} `}
              </span>
              <textarea
                id={composer_field_id}
                className="chat__field"
                aria-label="Message to agent"
                aria-describedby={caption_id}
                placeholder={field_hint(props)}
                rows={1}
                value={composer.text}
                readOnly={composer.busy}
                disabled={!composer_props.linked || !composer.readable}
                onChange={(event) => composer.change(event.target.value)}
                onKeyDown={send_key}
              />
            </span>
            <button
              type="button"
              className="chat__send"
              aria-label="Send"
              disabled={!ready}
              onClick={composer.send}
            >
              <span className="chat__send-plate">{icon_send}</span>
            </button>
          </div>
        </div>
        <ComposerCaption {...props} />
      </div>
    </div>
  )
}

function AddSketch({ composer, composer_props }: ChatProps) {
  const on = composer.include_sketch
  const possible = composer_props.editor !== null && composer_props.linked && !composer.busy
  return (
    <>
      <button
        type="button"
        className="chat__add"
        aria-pressed={on}
        aria-label={on ? 'Sketch added' : 'Add sketch'}
        disabled={!possible}
        onClick={() => composer.attach(!on)}
      >
        {icon_sketch}
        {!on && <span>Add sketch</span>}
      </button>
      {!on && <span className="chat__rule" aria-hidden="true" />}
    </>
  )
}

function field_hint({ title, linked, paired, role, composer }: ChatProps): string {
  if (!linked) return 'Link an agent on the Mac to chat here'

  if (!composer.readable) return 'Cannot read this board’s draft. Check the chat.'

  if (!paired) {
    return role === 'draw' ? 'Scan the Mac stage QR to chat here' : 'Reload to chat here'
  }

  return `Message the agent about ${title}`
}

function ComposerCaption({ composer, composer_props, role }: ChatProps) {
  const [left, right] = caption_text({ composer, composer_props, role })
  return (
    <p id={caption_id} className="chat__caption" data-trouble={composer.refusal !== null}>
      <span>{left}</span>
      {right !== '' && <span>{right}</span>}
    </p>
  )
}

type CaptionInput = Pick<ChatProps, 'composer' | 'composer_props' | 'role'>

function caption_text({ composer, composer_props, role }: CaptionInput): [string, string] {
  const keys = role === 'stage' ? 'Return sends' : ''

  if (composer.refusal !== null) return [`Not sent: ${composer.refusal}`, '']

  if (!composer.stored) return ['This device cannot keep the draft. It stays while open.', '']

  if (composer.pending !== null) {
    return ['Draft kept for this board.', 'One message is waiting above.']
  }

  if (composer.busy) return ['Sending. The words stay until the Mac has them.', '']

  if (!composer_props.linked) return ['Nothing is sent and nothing is queued for later.', '']

  if (composer.include_sketch) return ['Sends your sketch as it is now, with these words.', keys]

  return ['Words only, to the agent linked to this board.', keys || 'Your sketch stays as it is.']
}

// The sketch as it will go: a small picture of it and how many shapes it holds. Read only
// while it is added.
function SketchToSend({ editor, onRemove }: { editor: Editor | null; onRemove: () => void }) {
  const shapes = useValue('chat sketch', () => editor?.getCurrentPageShapes() ?? [], [editor])
  const picture = use_picture(editor, shapes)
  return (
    <div className="chat__attached">
      <span className="chat__picture chat__picture--small" aria-hidden="true">
        {picture !== null && <img src={picture} alt="" />}
      </span>
      <span className="chat__sketch-text">
        <span className="chat__sketch-title">Sketch, as it is now</span>
        <span className="chat__sketch-meta">
          {shapes.length} {shapes.length === 1 ? 'shape' : 'shapes'}
        </span>
      </span>
      <button type="button" className="chat__remove" aria-label="Remove sketch" onClick={onRemove}>
        {icon_close_small}
      </button>
    </div>
  )
}

function use_picture(editor: Editor | null, shapes: readonly unknown[]): string | null {
  const [picture, picture_set] = useState<string | null>(null)
  useEffect(() => {
    if (editor === null || shapes.length === 0) return picture_set(null)

    let cancelled = false
    const timer = window.setTimeout(() => {
      const ids = [...editor.getCurrentPageShapeIds()]
      editor
        .getSvgString(ids, { padding: 16, background: false })
        .then((result) => {
          if (cancelled) return

          const small = result !== undefined && result.svg.length <= picture_bytes_max
          picture_set(
            small ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}` : null,
          )
        })
        .catch(() => undefined)
    }, picture_delay_ms)
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [editor, shapes])
  return picture
}
