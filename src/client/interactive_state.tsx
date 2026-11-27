// The view this device has chosen of an interactive revision. The choice lives in this page's
// memory only: it is never sent, saved or published, and it never moves a camera or touches
// the sketch. Another device, the Mac stage and a fresh open each show the revision at rest.
//
// A choice belongs to one board and one revision. When the revision changes, by a publish or
// a restore, the choice is let go and the new revision is shown at rest; a choice made for an
// older revision is never applied to a newer one. The scene is asked for once per revision,
// and only for a revision the status says is interactive: a static or retired revision costs
// no request and no scene.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { assert } from '../shared/assert'
import { board_query } from '../shared/board_session'
import type { CanvasRecord, CleanedDocument } from '../shared/canvas_types'
import {
  interactive_attempts_count_max,
  interactive_param,
  path_cleaned_view,
} from '../shared/constants'
import type { ViewState, ViewTap } from '../shared/scene_controls'
import {
  interactive_scene_read,
  interactive_view,
  scene_envelope,
  view_state_key,
  view_state_same,
  view_state_with,
  type LocalScene,
  type SceneEnvelope,
} from './interactive_scene'
import type { PrintChoice } from './print_engine'

// The chosen view of the revision on screen.
export type ViewChoice = {
  session: string
  revision: number
  scene: LocalScene
  envelope: SceneEnvelope | null
  state: ViewState
  at_rest: boolean

  // Names the view, so the print and a choice made on it can tell views apart.
  key: string
  taps: ViewTap[]

  // The records of the chosen view; null at rest, where the revision's own records are shown.
  records: CanvasRecord[] | null
  choose: (control: string, value: string) => boolean
}

type Loaded = { session: string; revision: number; scene: LocalScene }
type Chosen = { session: string; revision: number; state: ViewState }

const request_timeout_ms = 5000
const retry_delay_ms = 1500

const ViewChoiceContext = createContext<ViewChoice | null>(null)

export const ViewChoiceProvider = ViewChoiceContext.Provider

export function use_view_choice(): ViewChoice | null {
  return useContext(ViewChoiceContext)
}

export function use_interactive(
  session: string,
  document: CleanedDocument | null,
): ViewChoice | null {
  const revision = document?.revision ?? 0
  const interactive = document?.current?.interactive === true && revision > 0
  const loaded = use_scene_load(session, interactive ? revision : 0)
  const [chosen, chosen_set] = useState<Chosen | null>(null)

  // A new revision, or a restore, lets go of the choice made on the one before.
  useEffect(() => chosen_set(null), [session, revision])

  const scene = interactive && loaded?.revision === revision ? loaded.scene : null
  const bound = chosen?.session === session && chosen.revision === revision
  const state = scene === null ? null : bound ? chosen.state : scene.rest
  const view = useMemo(() => view_project(scene, state), [scene, state])
  const envelope = useMemo(() => (scene === null ? null : scene_envelope(scene.elements)), [scene])

  const choose = useCallback(
    (control: string, value: string): boolean => {
      if (scene === null || state === null) return false

      const next = view_state_with(scene, state, control, value)

      if (next === null) return false

      chosen_set({ session, revision: scene.revision, state: next })
      return true
    },
    [session, scene, state],
  )

  return useMemo(() => {
    if (scene === null || state === null || view === null) return null

    assert(scene.revision === revision, 'a choice is of the revision on screen')
    const at_rest = view_state_same(state, scene.rest)
    return {
      session,
      revision,
      scene,
      envelope,
      state,
      at_rest,
      key: view_state_key(scene, state),
      taps: view.taps,
      records: at_rest ? null : view.records,
      choose,
    }
  }, [session, revision, scene, envelope, state, view, choose])
}

// What the print is asked to show of the choice: nothing at rest, where it shows the
// revision's own records, and otherwise the chosen view's records, named.
export function use_print_choice(choice: ViewChoice | null): PrintChoice | null {
  return useMemo(() => {
    if (choice === null || choice.records === null) return null

    assert(!choice.at_rest, 'a view at rest prints the revision itself')
    return { revision: choice.revision, key: choice.key, records: choice.records }
  }, [choice])
}

// The view's records and taps. A projection that fails is a fault in this page: it is raised
// where the page reports faults, and the revision is shown at rest instead.
function view_project(scene: LocalScene | null, state: ViewState | null) {
  if (scene === null || state === null) return null

  try {
    return interactive_view(scene, state)
  } catch (error) {
    window.setTimeout(() => {
      throw error
    }, 0)
    return null
  }
}

// The scene of one interactive revision, asked for once, and again only after a failed
// request, a bounded number of times. A refusal of what came back is final for the revision:
// it is shown at rest. 0 asks for nothing.
function use_scene_load(session: string, revision: number): Loaded | null {
  const [loaded, loaded_set] = useState<Loaded | null>(null)

  useEffect(() => {
    if (revision === 0) return

    let stopped = false
    let timer = 0
    let attempts_count = 0
    const query = `?${board_query(session)}&${interactive_param}=1`

    const load = async (): Promise<void> => {
      attempts_count += 1
      assert(attempts_count <= interactive_attempts_count_max, 'attempts are bounded')
      const text = await text_get(`${path_cleaned_view}${query}`)

      if (stopped) return

      const read = text === null ? null : interactive_scene_read(text, revision)

      if (read?.ok === true) {
        loaded_set({ session, revision, scene: read.scene })
        return
      }

      if (read !== null || attempts_count >= interactive_attempts_count_max) return

      timer = window.setTimeout(() => void load(), retry_delay_ms * attempts_count)
    }
    void load()
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [session, revision])

  return loaded?.session === session && loaded.revision === revision ? loaded : null
}

async function text_get(pathname: string): Promise<string | null> {
  try {
    const response = await fetch(pathname, {
      cache: 'no-store',
      signal: AbortSignal.timeout(request_timeout_ms),
    })
    return response.ok ? await response.text() : null
  } catch {
    return null
  }
}
