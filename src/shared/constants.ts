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

// The Agent canvas as pages read it, and the restore of an earlier revision.
export const path_cleaned_json = '/api/cleaned.json'
export const path_cleaned_status = '/api/cleaned/status'
export const path_cleaned_restore = '/api/cleaned/restore'

// The Agent canvas for a page that shows its controls: the records of one view state, the
// controls, and what a tap on a shape sets. `?state=` is a JSON object of control values.
export const path_cleaned_view = '/api/cleaned/view.json'

// A draft waiting to be rendered, and its rendering. Only the Mac's own stage uses these.
export const path_preview_json = '/api/preview.json'
export const path_preview_png = '/api/preview.png'

// Board management routes. Board-scoped requests name their stable id with `?session=<id>`.
export const path_sessions = '/api/sessions'
export const path_sessions_rename = '/api/sessions/rename'
export const path_sessions_delete = '/api/sessions/delete'

// The response header that names the document an image shows.
export const header_document_hash = 'x-document-hash'

export const roles = ['draw', 'stage'] as const
export type Role = (typeof roles)[number]

// The board is a personal tool: one iPad, one Mac page, and some slack for reloads that have
// not yet timed out on the server.
export const sessions_count_max = 16

// Board sessions are listed in one registry. Each is a whole board, so only a few are held in
// memory at once: an idle one is saved and set aside to open another. A request for a board
// beyond that, while every open one is in use, is refused rather than queued.
export const board_sessions_count_max = 64
export const boards_open_count_max = 8
export const board_name_length_max = 80

// A title an agent proposes on the first cleanup of an untitled board: a few words.
export const board_title_length_max = 60

// A create or rename request names one board; anything larger is not one.
export const session_request_size_bytes_max = 1024

// How often a page asks for the list of boards, for names set elsewhere.
export const board_sessions_poll_interval_ms = 3000

// A single sync message. Strokes are small; this bound only stops a runaway client.
export const sync_message_size_bytes_max = 16 * 1024 * 1024

// The rendered drawing. The stage caps the longest edge, so a PNG stays far below this.
export const image_size_bytes_max = 32 * 1024 * 1024
export const image_edge_pixels_max = 3072
export const image_scale_max = 2

// Space the stage leaves around the drawing in its image, in page units before scaling.
export const image_padding_px = 32

// The page-space rectangle of a rendered image is a small query parameter; this bounds it.
export const image_bounds_units_max = 10_000_000

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

// Scene proposals come from an external agent and are untrusted. The bounds keep one
// proposal, its native tldraw records, and the retained history small enough to validate and
// write synchronously.
export const proposal_size_bytes_max = 1024 * 1024
export const proposal_shapes_count_max = 800
export const proposal_text_length_max = 2000
export const proposal_summary_length_max = 280
export const proposal_coordinate_units_max = 1_000_000
export const proposal_extent_units_max = 100_000

// One path has at most this many points, and groups nest at most this deep.
export const scene_path_points_count_max = 400
export const scene_depth_max = 8

// Sketch strokes an agent may name, across the whole scene.
export const scene_stroke_ids_count_max = 2000

// Controls an agent may give a scene, and the views they choose between. Every view is a part
// of the one scene: a control hides and shows elements and never adds one, so a view is never
// larger than the scene. Views are projected one at a time, never enumerated.
export const scene_controls_count_max = 8
export const scene_control_options_count_max = 12
export const scene_control_label_length_max = 60
export const scene_conditions_count_max = 4

// A view state names one value for each control: a small JSON object in a query parameter.
export const view_state_size_bytes_max = 1024

// The scene of an interactive revision, as a page that projects its own views reads it once:
// the agent's elements, up to a proposal's size, and the strokes the board copied into them,
// up to the canvas's pen samples. A larger scene is not offered, and the page shows the view
// at rest. A whole view response, its records with the scene, is read up to the second bound.
export const interactive_scene_size_bytes_max = 8 * 1024 * 1024
export const interactive_view_size_bytes_max = 16 * 1024 * 1024

// The query parameter that asks a view for its scene, and how often a page tries to load it.
export const interactive_param = 'interactive'
export const interactive_attempts_count_max = 3

// Pen samples one canvas keeps, across the strokes copied from the sketch and the agent's own:
// about 2 MB of saved strokes a revision, so the retained history, nine revisions at most,
// still saves in one quick write.
export const ink_points_count_max = 64_000

// The native records of one canvas: a shape for each element, two bindings for each arrow and
// a shape for each copied stroke.
export const canvas_records_count_max = proposal_shapes_count_max * 3 + scene_stroke_ids_count_max

// One draft at a time waits for the stage to render it. The stage asks this often, and a
// preview request waits this long for the image before it says the stage is slow.
export const preview_poll_interval_ms = 500
export const preview_wait_ms_max = 4000
export const preview_attempts_count_max = 5

// Stroke summaries in a cleanup snapshot: ids and bounds, not every pen sample.
export const stroke_summaries_count_max = 2000

// Prior cleaned revisions kept for an explicit restore. Older ones are dropped.
export const cleaned_history_count_max = 8

// A restore request names two revisions; anything larger is not a restore.
export const restore_request_size_bytes_max = 1024

// How often a page asks whether the cleaned diagram changed or went stale.
export const cleaned_poll_interval_ms = 1500

// A snapshot retries when the sketch changes between its image and its records.
export const snapshot_attempts_count_max = 4

export const document_hash_length = 16
export const document_hash_pattern = /^[0-9a-f]{16}$/

assert(save_delay_ms < save_delay_ms_max, 'save_delay_ms < save_delay_ms_max')
assert(render_delay_ms < fetch_wait_ms_max, 'render_delay_ms < fetch_wait_ms_max')
assert(poll_interval_ms < status_timeout_ms, 'poll_interval_ms < status_timeout_ms')
assert(image_size_bytes_max <= 64 * 1024 * 1024, 'image fits comfortably in memory')
assert(proposal_size_bytes_max < image_size_bytes_max, 'a proposal fits the request limit')
assert(scene_depth_max < proposal_shapes_count_max, 'nesting is bounded by the elements')
assert(scene_path_points_count_max >= 2, 'a path joins at least two points')
assert(ink_points_count_max > 0, 'a canvas keeps some pen samples')
assert(canvas_records_count_max <= 8192, 'one canvas stays quick to validate and save')
assert(preview_poll_interval_ms < preview_wait_ms_max, 'the stage asks while a preview waits')
assert(cleaned_poll_interval_ms >= poll_interval_ms, 'pages poll no faster than the command')
assert(board_title_length_max <= board_name_length_max, 'a title fits a name')
assert(scene_control_options_count_max >= 2, 'a control chooses between at least two values')
assert(
  Number.isSafeInteger(scene_control_options_count_max ** scene_controls_count_max),
  'the number of views is an exact count',
)
assert(
  interactive_scene_size_bytes_max < interactive_view_size_bytes_max,
  'a view response holds its scene',
)
assert(boards_open_count_max <= board_sessions_count_max, 'open boards are listed boards')
assert(
  boards_open_count_max * sessions_count_max <= 256,
  'connections across open boards stay a personal handful',
)
assert(Number.isSafeInteger(restart_clock_jump * 1_000_000), 'a million restarts stay exact')
