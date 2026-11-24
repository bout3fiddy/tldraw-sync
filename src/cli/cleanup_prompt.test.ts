// The prompt is the only place the tidy-only contract reaches the agent, so its wording is
// tested: it must never tell the agent to approximate or drop what the format cannot hold.

import { expect, test } from 'bun:test'
import { proposal_kinds } from '../shared/cleanup_types'
import { cleanup_prompt, proposal_subset_text } from './cleanup_prompt'
import { help_commands } from './help'

const prompt = cleanup_prompt({
  image_path: '/tmp/cleanup/sketch.png',
  records_path: '/tmp/cleanup/sketch.json',
  proposal_path: '/tmp/cleanup/proposal.json',
  snapshot: '0123456789abcdef',
  base_revision: 4,
  mapping: { x0: -32, y0: -32, ppu: 2 },
})

// Line breaks and indentation are layout: the wording is compared on one line.
const flat = (text: string) => text.replace(/\s+/g, ' ')

test('the prompt never tells the agent to leave content out or to draw a line as an arrow', () => {
  expect(prompt).not.toContain('Leave out anything else')
  expect(flat(prompt)).not.toMatch(/line between two shapes as an arrow/i)
  expect(flat(prompt)).not.toMatch(/leave out anything/i)
  expect(flat(prompt)).not.toMatch(/(omit|skip|ignore) (anything|whatever|the rest)/i)
})

test('the prompt tells the agent to stop and report what cannot be represented', () => {
  const text = flat(prompt)
  expect(text).toContain('a plain line without an arrowhead')
  expect(text).toContain('never turn one into an arrow')
  expect(text).toContain('Draw an arrow only where the sketch shows an arrowhead')
  expect(text).toContain('STOP. Do not publish.')
  expect(text).toContain('Do not leave the part out, guess, or draw the nearest thing.')
  expect(text).toContain('Tell the user which parts cannot be represented or are ambiguous')

  // The check comes before the agent is told to write or publish anything.
  expect(prompt.indexOf('STOP')).toBeLessThan(prompt.indexOf('Write one JSON object'))
  expect(prompt.indexOf('STOP')).toBeLessThan(prompt.indexOf('cleanup-publish --file'))
})

test('the prompt keeps its tidy-only contract and the facts of its snapshot', () => {
  expect(prompt).toContain('Tidy only.')
  expect(prompt).toContain('Do not add, remove, merge, split, rename, reword, correct')
  expect(prompt).toContain('"snapshot": "0123456789abcdef" and "base_revision": 4')
  expect(prompt).toContain('x = -32 + pixel_x / 2')
  expect(prompt).toContain('tldraw-sync cleanup-publish --file /tmp/cleanup/proposal.json --json')
})

test('the representable subset is stated once and shown in the prompt and both helps', () => {
  expect(flat(prompt)).toContain(flat(proposal_subset_text))
  expect(help_commands['cleanup-publish']).toContain(proposal_subset_text)
  expect(help_commands['cleanup-snapshot']).toContain(proposal_subset_text)
  expect(help_commands['cleanup-publish']).toContain('do not publish')
  expect(help_commands['cleanup-publish']).toContain('proposal_unreadable')

  // The subset names every kind the format has, and no kind the format lacks.
  expect([...proposal_kinds].sort()).toEqual(['arrow', 'ellipse', 'rectangle', 'text'])

  for (const word of ['text', 'rectangles', 'ellipses', 'arrow']) {
    expect(proposal_subset_text).toContain(word)
  }
})
