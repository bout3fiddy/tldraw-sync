// The mechanical parts of TigerStyle, enforced: a limit on line length, a limit on function
// length, snake_case file names, and a floor on assertion density where the invariants live.
// What cannot be checked by a machine (naming, comments that say why) is left to review.

import { expect, test } from 'bun:test'
import fs from 'node:fs'
import path from 'node:path'
import ts from 'typescript'

const line_columns_max = 100
const function_lines_max = 70
const files_count_max = 500
// TigerStyle asks for two assertions per function on average. The server and shared code hold
// the system's invariants, so that is where the density is measured.
const assertions_per_function_min = 2

const root = path.resolve(import.meta.dir)
const files = [...new Bun.Glob('**/*.{ts,tsx,css}').scanSync(root)].sort()

function source_parse(file: string): ts.SourceFile {
  const text = fs.readFileSync(path.join(root, file), 'utf8')
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
}

// Visits every node without recursion: an explicit stack, bounded by the size of the file.
function nodes_visit(source: ts.SourceFile, visit: (node: ts.Node) => void): void {
  const pending: ts.Node[] = [source]
  while (pending.length > 0) {
    const node = pending.pop() as ts.Node
    visit(node)
    node.forEachChild((child) => {
      pending.push(child)
    })
  }
}

test('there are source files to check', () => {
  expect(files.length).toBeGreaterThan(10)
  expect(files.length).toBeLessThan(files_count_max)
})

test(`no line is longer than ${line_columns_max} columns`, () => {
  const long: string[] = []
  for (const file of files) {
    fs.readFileSync(path.join(root, file), 'utf8').split('\n').forEach((line, index) => {
      if (line.length > line_columns_max) long.push(`${file}:${index + 1} (${line.length})`)
    })
  }
  expect(long).toEqual([])
})

test(`no function is longer than ${function_lines_max} lines`, () => {
  const long: string[] = []
  for (const file of files.filter((name) => !name.endsWith('.css'))) {
    const source = source_parse(file)
    nodes_visit(source, (node) => {
      if (!ts.isFunctionLike(node)) return
      const first = source.getLineAndCharacterOfPosition(node.getStart()).line
      const last = source.getLineAndCharacterOfPosition(node.getEnd()).line
      const lines = last - first + 1
      if (lines > function_lines_max) long.push(`${file}:${first + 1} (${lines} lines)`)
    })
  }
  expect(long).toEqual([])
})

test('file names are snake_case', () => {
  const misnamed = files.filter((file) => !/^[a-z0-9_/]+(\.test)?\.(ts|tsx|css)$/.test(file))
  expect(misnamed).toEqual([])
})

test('the server and shared code average two assertions per function', () => {
  let assertions_count = 0
  let functions_count = 0
  for (const file of files) {
    if (!/^(server|shared)\//.test(file) || file.includes('.test.')) continue
    const source = source_parse(file)
    nodes_visit(source, (node) => {
      if (ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) functions_count += 1
      if (ts.isCallExpression(node) && node.expression.getText(source) === 'assert') {
        assertions_count += 1
      }
    })
  }
  const density = assertions_count / functions_count
  console.log(`assertions ${assertions_count}, functions ${functions_count}: ${density.toFixed(2)}`)
  expect(density).toBeGreaterThanOrEqual(assertions_per_function_min)
})
