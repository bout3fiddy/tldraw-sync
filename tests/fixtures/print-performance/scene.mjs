// A dense interactive scene for measuring the print: 772 elements, as on the board this was
// profiled for, behind three controls of 6, 4 and 5 options (120 states). The first control
// shows disjoint sets of boxes, arrows and notes, so each of its options is a view of new
// top-level shapes. Deterministic: the same scene every run, with no randomness.

export const scene_elements_count = 772

// Elements only one option of the first control shows, in its order. Together with the
// common elements they make the scene's 772.
export const option_sizes = [8, 142, 185, 200, 120, 100]
export const common_count = scene_elements_count - option_sizes.reduce((a, b) => a + b, 0)

export const modes = ['m0', 'm1', 'm2', 'm3', 'm4', 'm5']

// Short labels, so the whole switch fits a 1440 px window unfolded and each option is one
// press away, as on the board measured.
export const mode_labels = ['All', 'Ingest', 'Accts', 'Ledger', 'Bill', 'Audit']
export const lens_labels = ['L1', 'L2', 'L3', 'L4', 'L5']

const steps = ['s0', 's1', 's2', 's3']
const lenses = ['l0', 'l1', 'l2', 'l3', 'l4']

export function scene_controls() {
  const option = (value, label) => ({ value, label })
  return [
    {
      id: 'mode',
      kind: 'choice',
      label: 'Accounts',
      options: modes.map((value, index) => option(value, mode_labels[index])),
    },
    {
      id: 'step',
      kind: 'steps',
      label: 'Step',
      options: steps.map((value, index) => option(value, `S${index + 1}`)),
    },
    {
      id: 'lens',
      kind: 'choice',
      label: 'Lens',
      options: lenses.map((value, index) => option(value, lens_labels[index])),
    },
  ]
}

// The id of an element that only `mode` shows, which a benchmark waits to see painted.
export function sentinel_id(mode_index) {
  return `m${mode_index}-box0`
}

// One option's elements: a grid of labelled boxes, linked in rows by labelled arrows, with a
// note under some. Arrows join boxes of the same option only, so every view is whole. The
// grid is wide rather than tall, so a fitted camera leaves room for the switch above it.
function option_elements(mode_index, size) {
  const when = [{ control: 'mode', values: [modes[mode_index]] }]
  return grid_elements(`m${mode_index}`, size, when, 16)
}

function grid_elements(prefix, size, when, columns) {
  const elements = []
  const boxes = []
  let box_count = 0

  for (let index = 0; elements.length < size; index += 1) {
    const kind = index % 5
    const id = `${prefix}-box${box_count}`

    if (kind === 4) {
      const anchor = boxes[boxes.length - 1]
      elements.push({
        type: 'text',
        id: `${prefix}-note${index}`,
        x: anchor.x,
        y: anchor.y + 90,
        text: `Note ${index}: settles nightly`,
        font: 'sans',
        size: 's',
        visible_when: when,
      })
      continue
    }

    const column = box_count % columns
    const row = Math.floor(box_count / columns)
    const box = {
      type: 'geo',
      id,
      x: column * 260,
      y: row * 160,
      w: 200,
      h: 72,
      text: `Account ${prefix}.${box_count}`,
      font: 'sans',
      size: 's',
      fill: box_count % 3 === 0 ? 'semi' : 'none',
      visible_when: when,
    }
    elements.push(box)
    boxes.push(box)
    box_count += 1
    const previous = boxes[boxes.length - 2]

    if (column > 0 && previous !== undefined && elements.length < size) {
      elements.push({
        type: 'arrow',
        id: `${prefix}-arrow${box_count}`,
        from: previous.id,
        to: box.id,
        text: 'posts',
        font: 'sans',
        size: 's',
        visible_when: when,
      })
    }
  }

  return elements.slice(0, size)
}

// Elements every view shows, and a few that only some steps and lenses show, so a change of
// those controls also changes the view.
function common_elements() {
  const elements = [
    { type: 'text', id: 'title', x: 0, y: -160, text: 'Configured accounts', size: 'l' },
    {
      type: 'path',
      id: 'rule',
      points: [
        [0, -100],
        [4100, -100],
      ],
    },
  ]

  for (let index = 0; elements.length < common_count; index += 1) {
    const step = steps[index % steps.length]
    const lens = lenses[index % lenses.length]
    elements.push({
      type: 'geo',
      id: `common${index}`,
      x: 4300,
      y: index * 90,
      w: 180,
      h: 60,
      text: `Legend ${index}`,
      font: 'sans',
      size: 's',
      visible_when:
        index % 2 === 0
          ? [{ control: 'step', values: [step] }]
          : [{ control: 'lens', values: [lens] }],
    })
  }

  return elements
}

// The views of the scale sweep: a small view at rest, and a large one of `roots_count`
// top-level shapes the small one does not show, which a toggle adds a few notes to. The
// largest sweep fills a scene to the 800 elements a proposal may hold.
export const sweep_small_count = 40
export const sweep_extra_count = 8
export const sweep_roots_count_max = 800 - sweep_small_count - sweep_extra_count - 1

export function scene_sweep(roots_count) {
  if (!Number.isSafeInteger(roots_count) || roots_count < 1) {
    throw new Error('A sweep view has shapes.')
  }

  if (roots_count > sweep_roots_count_max) {
    throw new Error(`A sweep view has at most ${sweep_roots_count_max} shapes.`)
  }

  const small = [{ control: 'mode', values: ['small'] }]
  const large = [{ control: 'mode', values: ['large'] }]
  const extra = [...large, { control: 'extra', values: ['on'] }]
  const columns = Math.max(16, Math.ceil(Math.sqrt(roots_count * 3)))
  const notes = Array.from({ length: sweep_extra_count }, (_, index) => ({
    type: 'text',
    id: `extra${index}`,
    x: index * 520,
    y: -120,
    text: `Extra note ${index}`,
    font: 'sans',
    size: 's',
    visible_when: extra,
  }))
  const elements = [
    { type: 'text', id: 'title', x: 0, y: -260, text: 'Configured accounts', size: 'l' },
    ...grid_elements('s', sweep_small_count, small, 16),
    ...grid_elements('l', roots_count, large, columns),
    ...notes,
  ]
  const controls = [
    {
      id: 'mode',
      kind: 'choice',
      label: 'Size',
      options: [
        { value: 'small', label: 'Small' },
        { value: 'large', label: 'Large' },
      ],
    },
    { id: 'extra', kind: 'toggle', label: 'Extra' },
  ]
  return { controls, elements }
}

export function scene_dense() {
  const elements = common_elements()

  for (const [mode_index, size] of option_sizes.entries()) {
    elements.push(...option_elements(mode_index, size))
  }

  if (elements.length !== scene_elements_count) {
    throw new Error(`The dense scene has ${elements.length} elements.`)
  }

  return { controls: scene_controls(), elements }
}
