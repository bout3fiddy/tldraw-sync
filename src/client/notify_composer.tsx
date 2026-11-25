import { useLayoutEffect, useRef, useState } from 'react'
import type { Editor } from 'tldraw'
import type { BoardEvent } from '../shared/whiteboard'
import { draft_load, send_event, send_prepare, type Draft } from './notify_delivery'

type Props = {
  editor: Editor | null
  online: boolean
  session: string
  token: string | null
  feedback: (value: string) => void
  confirm: (event: BoardEvent) => void
}

function use_draft(props: Props) {
  const key = `tldraw-sync.notify.${props.session}`
  const [initial] = useState(() => {
    try {
      return draft_load(key)
    } catch {
      return null
    }
  })
  const draft = useRef<Draft>(initial ?? { text: '', pending: null })
  const [text, setText] = useState(draft.current.text)
  const edits = useRef(0)
  const save = (value: Draft) => {
    sessionStorage.setItem(key, JSON.stringify(value))
    draft.current = value
  }
  const change = (value: string) => {
    if (value.length > 8192) return props.feedback('Draft too long. Use up to 4000 characters.')

    edits.current++
    draft.current = { ...draft.current, text: value }
    setText(value)

    try {
      save(draft.current)
    } catch {
      props.feedback('Tab storage is unavailable.')
    }
  }
  return { initial, draft, text, setText, edits, save, change }
}

function use_delivery(props: Props) {
  const { initial, draft, text, setText, edits, save, change } = use_draft(props)
  const [interpret, setInterpret] = useState(draft.current.pending?.kind === 'interpret_request')
  const [busy, setBusy] = useState(false)
  const locked = useRef(false)
  const mounted = useRef(true)
  useLayoutEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  const send = async () => {
    const { editor, token, online, feedback } = props

    if (!editor || !token || !online || locked.current || !initial) return

    locked.current = true
    setBusy(true)
    const generation = edits.current

    try {
      const kind = interpret ? 'interpret_request' : 'sketch_notify'
      const request = draft.current.pending ?? send_prepare(editor, kind, draft.current.text)
      save({ ...draft.current, pending: request })
      const result = await send_event(props.session, token, request)

      if (!mounted.current) return

      const clear =
        result.ok && edits.current === generation && draft.current.text === (request.text ?? '')
      save({ text: clear ? '' : draft.current.text, pending: null })

      if (clear) setText('')

      if (result.ok) props.confirm(result.event)

      feedback(result.ok ? '' : result.message)
    } catch (error) {
      feedback(
        error instanceof TypeError || !(error instanceof Error)
          ? 'No confirmation. Notify again to retry the pending request.'
          : error.message,
      )
    } finally {
      locked.current = false
      setBusy(false)
    }
  }
  const disabled = !initial || busy || !props.editor || !props.token || !props.online
  return {
    text,
    change,
    send,
    interpret,
    setInterpret,
    disabled,
    available: initial !== null,
    retry: draft.current.pending !== null && !busy,
  }
}

export function NotifyComposer(props: Props) {
  const form = use_delivery(props)
  const area = useRef<HTMLTextAreaElement>(null)
  useLayoutEffect(() => {
    const field = area.current

    if (!field) return

    const resize = () => {
      field.style.height = 'auto'
      field.style.height = `${field.scrollHeight + 1}px`
    }
    resize()
    window.addEventListener('resize', resize)
    return () => window.removeEventListener('resize', resize)
  }, [form.text])
  return (
    <>
      <textarea
        ref={area}
        rows={1}
        aria-label="Note to agent"
        placeholder="Add a note (optional)"
        value={form.text}
        disabled={!form.available}
        onChange={(e) => form.change(e.target.value)}
        onKeyUp={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          e.stopPropagation()

          if (
            e.key === 'Enter' &&
            (e.metaKey || e.ctrlKey) &&
            !e.nativeEvent.isComposing &&
            e.nativeEvent.keyCode !== 229
          ) {
            e.preventDefault()
            void form.send()
          }
        }}
      />
      <button
        type="button"
        aria-pressed={form.interpret}
        onClick={() => form.setInterpret(!form.interpret)}
      >
        Interpret
      </button>
      <button type="button" disabled={form.disabled} onClick={() => void form.send()}>
        Notify agent
      </button>
      {!form.available && (
        <span role="alert">Cannot read this tab’s draft. Check board status.</span>
      )}
      {form.retry && <span>Notify retries the pending request.</span>}
    </>
  )
}
