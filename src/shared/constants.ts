// Every limit in the system lives here. Units and qualifiers come last in each name.

import { assert } from './assert'

// The board's port when it is free. Not 5173, which every Vite dev server reaches for first.
// When it is taken, the board takes any free port; the QR code always carries the real one.
export const port_default = 7357

// Paths shared by the server and the client.
export const path_draw = '/draw'
export const path_sync = '/sync'
export const path_drawing_png = '/api/drawing.png'
export const path_drawing_json = '/api/drawing.json'
export const path_pairing = '/api/pairing'
export const path_status = '/api/status'

// The response header that names the document an image shows.
export const header_document_hash = 'x-document-hash'

export const roles = ['draw', 'stage'] as const
export type Role = (typeof roles)[number]

// The board is a personal tool: one iPad, one Mac page, and some slack for reloads that have
// not yet timed out on the server.
export const sessions_count_max = 16

// A single sync message. Strokes are small; this bound only stops a runaway client.
export const sync_message_size_bytes_max = 16 * 1024 * 1024

// The rendered drawing. The stage caps the longest edge, so a PNG stays far below this.
export const image_size_bytes_max = 32 * 1024 * 1024
export const image_edge_pixels_max = 3072
export const image_scale_max = 2

// The stage renders once the pen has rested for this long.
export const render_delay_ms = 300
export const upload_attempts_count_max = 5
export const upload_retry_delay_ms = 1000

// While the stage is hidden, its animation frames come from a timer this often. A browser
// stretches timers in a hidden page to about a second, which is still quick enough to render
// the image before a fetch gives up.
export const hidden_frame_interval_ms = 50
// Frames waiting at once. tldraw keeps a handful; thousands would mean a leak.
export const hidden_frames_count_max = 1000

// A fetch that finds the image behind the document waits this long for the stage to catch up.
export const fetch_wait_ms_max = 3000
export const fetch_waiters_count_max = 16

// The board is saved once changes have paused for `save_delay_ms`, and never later than
// `save_delay_ms_max` after the first unsaved change. That is the most work a crash can lose.
export const save_delay_ms = 1000
export const save_delay_ms_max = 5000

// On every start the sync clock jumps by this much, so that a client which talked to the
// previous process can never mistake the restored history for its own. See `Board.open`.
export const restart_clock_jump = 1_000_000_000

// The command line. A board answers its status in well under this, or it is not answering.
export const status_timeout_ms = 1000
// A started board must be serving within this, including the first start of a cold machine.
export const start_wait_ms_max = 15_000
// A stopped board saves and exits within this.
export const stop_wait_ms_max = 10_000
// A browser opened by the command line has this long to load the stage and connect.
export const stage_open_wait_ms_max = 20_000
// How often the command line looks again while it waits for one of the above.
export const poll_interval_ms = 100
// A fetch asks for the image at most this many times; the server waits on each request.
export const fetch_attempts_count_max = 4

export const document_hash_length = 16
export const document_hash_pattern = /^[0-9a-f]{16}$/

assert(save_delay_ms < save_delay_ms_max, 'save_delay_ms < save_delay_ms_max')
assert(render_delay_ms < fetch_wait_ms_max, 'render_delay_ms < fetch_wait_ms_max')
assert(poll_interval_ms < status_timeout_ms, 'poll_interval_ms < status_timeout_ms')
assert(image_size_bytes_max <= 64 * 1024 * 1024, 'image fits comfortably in memory')
assert(Number.isSafeInteger(restart_clock_jump * 1_000_000), 'a million restarts stay exact')
