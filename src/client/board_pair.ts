import { useEffect, useState } from 'react'
import { credential_pattern } from '../shared/whiteboard'

let transient: { session: string; token: string } | null = null

// QR fragments are not sent to the server. Remove the fragment from browser history before the
// app mounts, and remember only the event token for this board in this tab.
export function pair_arrival(session: string): void {
  const params = new URLSearchParams(location.hash.slice(1))
  const token = params.get('pair')

  if (!token) return

  history.replaceState(history.state, '', location.pathname + location.search)

  if (!credential_pattern.test(token)) return

  transient = { session, token }

  try {
    sessionStorage.setItem(`board.pair.${session}`, token)
  } catch {
    // Storage is optional: the scanned page still works for this visit.
  }
}

// Scanning while the plain draw URL is already open may be fragment-only navigation. Pair that
// tab without a reload; the sketch editor and unsynced ink must stay mounted.
export function use_pair_token(session: string): string | null {
  const [token, setToken] = useState(() => pair_token(session))
  useEffect(() => {
    const arrive = () => {
      pair_arrival(session)
      setToken(pair_token(session))
    }
    arrive()
    window.addEventListener('hashchange', arrive)
    return () => window.removeEventListener('hashchange', arrive)
  }, [session])
  return token
}

function pair_token(session: string): string | null {
  if (transient?.session === session) return transient.token

  try {
    return sessionStorage.getItem(`board.pair.${session}`)
  } catch {
    return null
  }
}
