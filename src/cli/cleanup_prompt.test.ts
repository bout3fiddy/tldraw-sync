// The prompt is the only place the interpretation contract reaches the agent, so its wording is
// tested: copy meaning exactly and invent nothing, read ambiguity best effort without asking,
// and leave every position and style to the composer.

import { expect, test } from 'bun:test'
import { diagram_format, proposal_kinds } from '../shared/cleanup_types'
import { cleanup_prompt, diagram_schema_text, proposal_subset_text } from './cleanup_prompt'
import { help_commands } from './help'

const facts = {
  image_path: '/tmp/cleanup/sketch.png',
  records_path: '/tmp/cleanup/sketch.json',
  strokes_path: '/tmp/cleanup/strokes.json',
  diagram_path: '/tmp/cleanup/diagram.json',
  previous_path: null,
  snapshot: '0123456789abcdef',
  base_revision: 4,
  session: 'default',
  title_wanted: false,
  mapping: { x0: -32, y0: -32, ppu: 2 },
}
const prompt = cleanup_prompt(facts)

// Line breaks and indentation are layout: the wording is compared on one line.
const flat = (text: string) => text.replace(/\s+/g, ' ')

test('the prompt keeps meaning exact and invents nothing', () => {
  const text = flat(prompt)
  expect(text).toContain('Copy every written word exactly as drawn.')
  expect(text).toContain('Do not add, remove, merge, split, rename, reword, correct')
  expect(text).toContain('Invent no items or connections.')
  expect(text).toContain('Keep every arrowhead')
  expect(text).toContain('Never add or drop one.')
})

test('the prompt reads ambiguity best effort and never asks the user to clarify', () => {
  const text = flat(prompt)
  expect(text).toContain('as best you can')
  expect(text).toContain('Do not ask the user to clarify.')
  expect(text).not.toMatch(/STOP|Do not publish|let them decide/)
})

test('the prompt leaves layout to the tool and names its files and snapshot', () => {
  const text = flat(prompt)
  expect(text).toContain('Choose no positions, sizes, colours or styles')
  expect(text).toContain('/tmp/cleanup/strokes.json')
  expect(prompt).toContain('\"snapshot\": \"0123456789abcdef\" and \"base_revision\": 4')
  expect(prompt).toContain('x = -32 + pixel_x / 2')
  expect(prompt).toContain('tldraw-sync cleanup-publish --file /tmp/cleanup/diagram.json --json')
  expect(prompt).toContain(diagram_format)

  // The schema has no coordinates for the agent to choose.
  expect(diagram_schema_text).not.toMatch(/"x"|"y"|"w"|"h"/)

  // Writing comes before publishing.
  expect(prompt.indexOf('Write one JSON object')).toBeLessThan(prompt.indexOf('cleanup-publish'))
})

test('a previous interpretation is offered for its ids only when there is one', () => {
  expect(prompt).not.toContain('previous interpretation')
  const again = cleanup_prompt({ ...facts, previous_path: '/tmp/cleanup/diagram_previous.json' })
  expect(flat(again)).toContain(
    'The previous interpretation is /tmp/cleanup/diagram_previous.json. Keep its ids',
  )
})

// A board other than the default is named in the diagram and in every command; a title is
// asked for only while the board has no name.
test('the prompt binds the diagram to its board and asks for a title only when unnamed', () => {
  expect(prompt).toContain('"session": "default"')
  expect(prompt).not.toContain('--session')
  expect(prompt).not.toContain('no name yet')

  const other = cleanup_prompt({ ...facts, session: '0123456789abcdef', title_wanted: true })
  expect(other).toContain('"session": "0123456789abcdef"')
  expect(other).toContain(
    'tldraw-sync cleanup-publish --session 0123456789abcdef --file /tmp/cleanup/diagram.json',
  )
  expect(other).toContain('tldraw-sync cleanup-snapshot --session 0123456789abcdef --json')
  expect(flat(other)).toContain('This board has no name yet. Also add "title"')
  expect(flat(other)).toContain('unless someone names it first')
})

test('the semantic schema is in the compose help; the shape subset stays for legacy', () => {
  expect(help_commands['cleanup-compose']).toContain(diagram_schema_text)
  expect(help_commands['cleanup-publish']).toContain(proposal_subset_text)
  expect(help_commands['cleanup-publish']).toContain('proposal_unreadable')
  expect(help_commands['cleanup-publish']).toContain('invalid_diagram')
  expect(help_commands['cleanup-snapshot']).toContain('without asking the user to clarify')

  // The subset names every kind the shape format has, and no kind it lacks.
  expect([...proposal_kinds].sort()).toEqual(['arrow', 'ellipse', 'rectangle', 'text'])

  for (const word of ['text', 'rectangles', 'ellipses', 'arrow']) {
    expect(proposal_subset_text).toContain(word)
  }
})
