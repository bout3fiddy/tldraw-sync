// The attachment is opt-in. The same button removes it, without taking room from the field.
// Typing never reaches the canvas shortcuts. Only a confirmed send clears the words.

import type { KeyboardEvent } from 'react'
import { useValue, type Editor } from 'tldraw'
import type { ChatProps } from './chat_pane'
import { composer_ready } from './chat_state'
import { icon_boards, icon_send } from './icons'

export const composer_field_id = 'chat-field'
const caption_id = 'chat-caption'

const lost_text = {
  draw:
    'Lost the Mac. Your words are kept on this iPad. Send again when it is back: ' +
    'nothing is sent twice.',
  stage: 'The board has stopped. Your words are kept here until it is back.',
} as const

export function ChatComposer(props: ChatProps) {
  const { composer, composer_props, role } = props
  const ready = composer_ready(composer, composer_props)
  const caption = caption_text(props)
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
          {composer.include_sketch && <Attachment editor={composer_props.editor} />}
          <div className="chat__plate">
            <AddSketch {...props} />
            <span className="chat__field-box">
              <span className="chat__mirror" aria-hidden="true">{`${composer.text} `}</span>
              <textarea
                id={composer_field_id}
                className="chat__field"
                aria-label="Message to agent"
                aria-describedby={caption ? caption_id : undefined}
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
        {caption && (
          <p id={caption_id} className="chat__caption" role="status">
            {caption}
          </p>
        )}
      </div>
    </div>
  )
}

function AddSketch({ composer, composer_props }: ChatProps) {
  const on = composer.include_sketch
  const possible = composer_props.editor !== null && composer_props.linked && !composer.busy
  const label = on ? 'Remove sketch' : 'Add sketch'

  return (
    <button
      type="button"
      className="chat__add"
      aria-pressed={on}
      aria-label={label}
      title={label}
      disabled={!possible}
      onClick={() => composer.attach(!on)}
    >
      {icon_boards}
    </button>
  )
}

function Attachment({ editor }: { editor: Editor | null }) {
  const count = useValue('attached shapes', () => editor?.getCurrentPageShapeIds().size, [editor])

  return (
    <span className="chat__attached" role="status">
      Sketch attached{count !== undefined && ` · ${count} ${count === 1 ? 'shape' : 'shapes'}`}
    </span>
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

function caption_text({ composer, linked }: ChatProps): string | null {
  if (composer.refusal !== null) return `Not sent: ${composer.refusal}`

  if (!composer.stored) return 'This device cannot keep the draft. It stays while open.'

  if (composer.pending !== null) return 'One message is waiting above.'

  if (composer.busy) return 'Sending. The words stay until the Mac has them.'

  if (!linked) return 'Nothing is sent and nothing is queued for later.'

  return null
}
