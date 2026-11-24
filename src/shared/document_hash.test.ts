// The hash must ignore everything that is not the drawing (record order, key order) and
// notice everything that is.

import { expect, test } from 'bun:test'
import { document_hash, shapes_count, type DocumentRecord } from './document_hash'

const page = { id: 'page:page', typeName: 'page', name: 'Page 1' }
const shape = { id: 'shape:a', typeName: 'shape', x: 1, y: 2, props: { w: 3, colour: 'black' } }
// Test records carry fields beyond the two every record has.
const hash = (records: object[]) => document_hash(records as DocumentRecord[])

test('record order does not change the hash', () => {
  expect(document_hash([page, shape])).toBe(document_hash([shape, page]))
})

test('key order does not change the hash, at any depth', () => {
  const reordered = {
    props: { colour: 'black', w: 3 }, y: 2, x: 1, typeName: 'shape', id: 'shape:a',
  }
  expect(document_hash([page, reordered])).toBe(document_hash([page, shape]))
})

test('any change to a value changes the hash', () => {
  const base = document_hash([page, shape])
  expect(hash([page, { ...shape, x: 2 }])).not.toBe(base)
  expect(hash([page, { ...shape, props: { ...shape.props, w: 4 } }])).not.toBe(base)
  expect(document_hash([page])).not.toBe(base)
  expect(document_hash([page, shape, { id: 'shape:b', typeName: 'shape' }])).not.toBe(base)
})

test('array order is part of the value', () => {
  const forward = { id: 'shape:a', typeName: 'shape', points: [1, 2] }
  const reverse = { id: 'shape:a', typeName: 'shape', points: [2, 1] }
  expect(document_hash([forward])).not.toBe(document_hash([reverse]))
})

test('a record boundary cannot be moved without changing the hash', () => {
  const joined = [{ id: 'a', typeName: 'x', text: 'ab' }, { id: 'b', typeName: 'x', text: '' }]
  const split = [{ id: 'a', typeName: 'x', text: 'a' }, { id: 'b', typeName: 'x', text: 'b' }]
  expect(document_hash(joined)).not.toBe(document_hash(split))
})

test('the hash is sixteen lowercase hex characters, including for nothing', () => {
  expect(document_hash([])).toMatch(/^[0-9a-f]{16}$/)
  expect(document_hash([page, shape])).toMatch(/^[0-9a-f]{16}$/)
})

test('duplicate ids are a programmer error', () => {
  expect(() => document_hash([shape, shape])).toThrow('record ids are unique')
})

test('only shapes count as shapes', () => {
  expect(shapes_count([])).toBe(0)
  expect(shapes_count([page])).toBe(0)
  expect(shapes_count([page, shape])).toBe(1)
})
