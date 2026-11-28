// The views of a native board as a page reads them from records any page can write: controls
// that do not read whole are none, and a mark that does not read whole, or names what the
// controls lack, shows its shape in every view. A choice is a view of these controls or none.

import { expect, test } from 'bun:test'
import {
  shape_view_read,
  shape_view_shown,
  view_after_choice,
  view_in_effect,
  views_controls_read,
} from './native_views'

const controls_json = [
  {
    id: 'season',
    kind: 'choice',
    label: 'Season',
    options: [
      { value: 'summer', label: 'Summer' },
      { value: 'winter', label: 'Winter' },
    ],
  },
  { id: 'labels', kind: 'toggle', label: 'Labels' },
]

const winter = { visible_when: [{ control: 'season', values: ['winter'] }] }

test('controls are read whole from the document, or not at all', () => {
  const controls = views_controls_read({ view_controls: controls_json })
  expect(controls?.map((control) => control.id)).toEqual(['season', 'labels'])
  expect(controls?.[1]?.options.map((option) => option.value)).toEqual(['off', 'on'])

  const forged = [
    null,
    {},
    { view_controls: [] },
    { view_controls: 'season' },
    { view_controls: [{ ...controls_json[0], options: [{ value: 'one', label: 'One' }] }] },
    { view_controls: [{ ...controls_json[1], script: 'x' }] },
    { view_controls: [controls_json[1], controls_json[1]] },
  ]

  for (const meta of forged) expect([meta, views_controls_read(meta)]).toEqual([meta, null])
})

test('a mark that names what the controls lack can only show its shape', () => {
  const controls = views_controls_read({ view_controls: controls_json })!
  const summer = view_in_effect(controls, {}, false)
  const winter_view = view_in_effect(controls, { season: 'winter' }, false)
  const marked = shape_view_read({ view: winter }, controls)
  expect(shape_view_shown(marked, summer)).toBe(false)
  expect(shape_view_shown(marked, winter_view)).toBe(true)

  const forged = [
    { view: { visible_when: [{ control: 'weather', values: ['rain'] }] } },
    { view: { visible_when: [{ control: 'season', values: ['spring'] }] } },
    { view: { visible_when: [{ control: 'season', values: [] }] } },
    { view: { ...winter, on_tap: { control: 'season', value: 'spring' } } },
    { view: { ...winter, hide: true } },
    { view: 'winter' },
  ]

  for (const meta of forged) {
    const read = shape_view_read(meta, controls)
    expect([meta, read]).toEqual([meta, { when: [], tap: null }])
    expect(shape_view_shown(read, summer) && shape_view_shown(read, winter_view)).toBe(true)
  }
})

test('a choice is of these controls, and a stale one falls back to the view at rest', () => {
  const controls = views_controls_read({ view_controls: controls_json })!
  const rest = { season: 'summer', labels: 'off' }
  expect(view_in_effect(controls, {}, false).state).toEqual(rest)
  expect(view_in_effect(controls, { season: 'winter' }, true).state).toEqual(rest)
  expect(view_in_effect(controls, { stage: 'build' }, false).state).toEqual(rest)

  const chosen = view_in_effect(controls, { labels: 'on' }, false)
  expect(view_after_choice(chosen, 'season', 'winter')).toEqual({ season: 'winter', labels: 'on' })
  expect(view_after_choice(chosen, 'season', 'spring')).toBeNull()
  expect(view_after_choice(chosen, 'weather', 'rain')).toBeNull()
})
