// One build, two pages. The address decides the role: the QR code leads to the draw page,
// and the Mac opens the stage.

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import 'tldraw/tldraw.css'
import { assert } from '../shared/assert'
import { path_draw } from '../shared/constants'
import { DrawPage } from './draw_page'
import { StagePage } from './stage_page'
import './styles.css'

const root = document.getElementById('root')
assert(root !== null, 'the page has a root element')

const drawing = window.location.pathname === path_draw
document.documentElement.dataset.role = drawing ? 'draw' : 'stage'

createRoot(root).render(<StrictMode>{drawing ? <DrawPage /> : <StagePage />}</StrictMode>)
