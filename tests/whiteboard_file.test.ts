import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { binding_install, binding_read } from '../src/cli/whiteboard_file'

import { disk_open } from '../src/server/storage'
import { machine_key } from '../src/server/whiteboard_keys'

test('daemon restarts use a private key, never a public or linked key', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-key-')))
  const file = path.join(root, 'whiteboard.key')

  try {
    const first = machine_key(disk_open(root))
    assert.equal(machine_key(disk_open(root)) === first, true)
    fs.chmodSync(file, 0o644)
    assert.throws(() => machine_key(disk_open(root)), /Unsafe/)
    fs.chmodSync(file, 0o600)
    const other = path.join(root, 'separate')
    fs.renameSync(file, other)
    fs.symlinkSync(other, file)
    assert.throws(() => machine_key(disk_open(root)), /Cannot open/)
    assert.equal(fs.readFileSync(other, 'utf8') === first, true)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('a crash after atomic install but before temporary unlink is recoverable', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'binding-replay-')))
  const file = path.join(root, 'binding.json')
  const install = '1149cc20-2371-4bca-bba0-420c3ccac582'
  const temporary = path.join(root, `.${install}.partial`)
  const binding = { session: '1'.repeat(16), owner: 'replay', token: '2'.repeat(64) }

  try {
    fs.writeFileSync(temporary, JSON.stringify({ ...binding, install }), { mode: 0o600 })
    fs.linkSync(temporary, file)
    assert.deepEqual(binding_read(file), binding)
    assert.equal(fs.existsSync(temporary), false)
    binding_install(file, binding)
    fs.linkSync(file, path.join(root, 'unrelated'))
    assert.throws(() => binding_read(file))
    assert.equal(fs.statSync(file).nlink, 2)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('binding installation is private, repeatable and never overwrites another file', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-binding-')))
  const target = path.join(root, 'private', 'binding.json')
  const binding = { session: 'a'.repeat(16), owner: 'test-session', token: 'b'.repeat(64) }

  try {
    binding_install(target, binding)
    const first = fs.statSync(target)
    assert.equal(first.mode & 0o777, 0o600)
    binding_install(target, binding)
    assert.equal(fs.statSync(target).ino, first.ino)
    assert.deepEqual(binding_read(target), binding)
    assert.throws(() => binding_install(target, { ...binding, owner: 'another' }))
    assert.deepEqual(binding_read(target), binding)
    const link = path.join(root, 'linked-directory')
    fs.symlinkSync(path.dirname(target), link)
    assert.throws(() => binding_install(path.join(link, 'new'), binding))
    const leaf = path.join(root, 'linked-file')
    fs.symlinkSync(target, leaf)
    assert.throws(() => binding_install(leaf, binding))
    assert.throws(() => binding_read(leaf))
    fs.chmodSync(target, 0o644)
    assert.throws(() => binding_read(target))
    assert.throws(() => binding_install('relative.json', binding))
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})
