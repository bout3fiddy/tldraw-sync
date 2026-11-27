// The strip's one rule, and when the chat gives up the canvas to a keyboard. The browser
// journeys press the real buttons; these name every case of the rules underneath.

import { expect, test } from 'bun:test'
import { chat_cramped, chat_split_height_min_px } from './chat_pane'
import { pointer_tool, tool_after_press } from './tool_strip'

test('the pen and eraser are one choice, and pressing the one held puts it down', () => {
  const cases: [current: string, pressed: 'draw' | 'eraser', next: string][] = [
    ['draw', 'draw', pointer_tool],
    ['draw', 'eraser', 'eraser'],
    ['eraser', 'eraser', pointer_tool],
    ['eraser', 'draw', 'draw'],
    [pointer_tool, 'draw', 'draw'],
    [pointer_tool, 'eraser', 'eraser'],
  ]

  for (const [current, pressed, next] of cases) {
    expect(tool_after_press(current, pressed)).toBe(next)
  }

  // A tool the strip never offers, such as a hand left by a gesture, is let go of too.
  expect(tool_after_press('hand', 'draw')).toBe('draw')
})

test('the chat lies beside the canvas until a keyboard leaves it too short', () => {
  expect(chat_cramped(820)).toBe(false)
  expect(chat_cramped(575)).toBe(false)
  expect(chat_cramped(chat_split_height_min_px)).toBe(false)
  expect(chat_cramped(chat_split_height_min_px - 1)).toBe(true)
  expect(chat_cramped(0)).toBe(true)
  expect(() => chat_cramped(Number.NaN)).toThrow()
})
