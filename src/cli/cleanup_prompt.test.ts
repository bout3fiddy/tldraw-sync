// The prompt is the only place the interpretation contract reaches the agent, so its wording is
// tested: copy meaning exactly and invent nothing, read ambiguity best effort without asking,
// and leave every position and style to the composer.

import { expect, test } from 'bun:test'
import { diagram_format } from '../shared/cleanup_types'
import { cleanup_prompt, diagram_schema_text } from './cleanup_prompt'
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

test('the prompt leaves the look to the tool and names its files and snapshot', () => {
  const text = flat(prompt)
  expect(text).toContain('Choose no sizes, colours or styles.')
  expect(text).toContain('a black-and-white whiteboard')
  expect(text).toContain('Do not write a shape proposal with coordinates.')
  expect(text).toContain('/tmp/cleanup/strokes.json')
  expect(prompt).toContain('\"snapshot\": \"0123456789abcdef\" and \"base_revision\": 4')
  expect(prompt).toContain('x = -32 + pixel_x / 2')
  expect(prompt).toContain('tldraw-sync cleanup-publish --file /tmp/cleanup/diagram.json --json')
  expect(prompt).toContain(diagram_format)

  // The schema has no coordinates, sizes or colours for the agent to choose.
  expect(diagram_schema_text).not.toMatch(/"x"|"y"|"w"|"h"|"color"|"size"/)

  // Writing comes before a trial layout, which comes before publishing.
  const steps = ['Write one JSON object', 'cleanup-compose --file', 'cleanup-publish --file']
  const places = steps.map((step) => prompt.indexOf(step))
  expect(places.every((place) => place >= 0)).toBe(true)
  expect([...places].sort((a, b) => a - b)).toEqual(places)
})

// The cleanup that escaped put a board of notes on one line: the prompt said to place nothing,
// so the sketch's arrangement never reached the tool. Now it asks where every item sat.
test('the prompt asks where each item sat, and for headings as groups', () => {
  const text = flat(prompt)
  expect(text).toContain('Keep the arrangement. Give every node "at"')
  expect(text).toContain('is a group with the heading as its label')
  expect(text).toContain('A sketch may be a diagram, notes, lists, or all of them at once.')
  expect(diagram_schema_text).toContain('"at": [<left>, <top>, <width>, <height>]')
  expect(flat(diagram_schema_text)).toContain('Give it for every node, or for none')
})

test('a previous interpretation is offered, to be edited in place, only when there is one', () => {
  expect(prompt).not.toContain('previous interpretation')
  const again = cleanup_prompt({ ...facts, previous_path: '/tmp/cleanup/diagram_previous.json' })
  expect(flat(again)).toContain(
    'The previous interpretation is /tmp/cleanup/diagram_previous.json. Edit it rather than ' +
      'start again: keep its ids, labels, groups and "at" for everything the sketch still shows',
  )
  expect(flat(again)).toContain('so those parts stay where they are')
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

test('the semantic schema is in the compose help; the shape format is no longer taught', () => {
  expect(help_commands['cleanup-compose']).toContain(diagram_schema_text)
  expect(help_commands['cleanup-compose']).toContain('keeps that\narrangement')
  expect(help_commands['cleanup-publish']).toContain('proposal_unreadable')
  expect(help_commands['cleanup-publish']).toContain('invalid_diagram')
  expect(help_commands['cleanup-snapshot']).toContain('without asking the user to clarify')

  // An agent that reads the help finds no colours and no coordinates to reach for.
  for (const help of Object.values(help_commands)) {
    expect(help).not.toMatch(/"color"|light-blue|"kind": "rectangle"/)
  }
})
