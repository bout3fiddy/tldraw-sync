// One build, two pages. The address decides the role and the board: the QR code leads to a
// board's draw page, and the Mac opens its stage. `/` and `/draw` are role-specific homes.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'tldraw/tldraw.css'
import { assert } from '../shared/assert'
import { board_page_parse } from '../shared/board_session'
import { pair_arrival } from './board_pair'
import { App } from './app'
import { hidden_frames_install } from './hidden_frames'
import './styles.css'

const root = document.getElementById('root')
assert(root !== null, 'the page has a root element')

const page = board_page_parse(window.location.pathname) ?? {
  id: null,
  role: 'stage' as const,
}
if (page.role === 'draw' && page.id !== null) pair_arrival(page.id)
document.documentElement.dataset.role = page.role
// Only the stage: the iPad is in hand whenever it draws, and its pen path stays untouched.
if (page.role === 'stage') hidden_frames_install()

createRoot(root).render(
  <StrictMode>
    <App role={page.role} initial={page.id} />
  </StrictMode>,
)
