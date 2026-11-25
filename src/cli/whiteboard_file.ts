import fs from 'node:fs'
import path from 'node:path'
import { board_id_pattern } from '../shared/board_session'
import { credential_pattern, owner_pattern, type Binding } from '../shared/whiteboard'
import { descriptor_read_bounded } from './proposal_reader'

const refused = () => new Error('Use a private regular binding file under a safe absolute path.')
const uid = process.getuid?.()

export function binding_directory(file: string, create: boolean): string {
  if (!path.isAbsolute(file) || file !== path.resolve(file) || file.length > 4096) throw refused()

  const parent = path.dirname(file)
  let current = path.parse(file).root

  for (const part of parent.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part)
    let stat = fs.lstatSync(current, { throwIfNoEntry: false })

    if (!stat && create) {
      fs.mkdirSync(current, { mode: 0o700, recursive: true })
      stat = fs.lstatSync(current)
    }

    if (!stat?.isDirectory() || (stat.uid !== uid && stat.uid !== 0)) throw refused()

    if (stat.mode & 0o022 && !(stat.uid === 0 && stat.mode & 0o1000)) throw refused()
  }

  const stat = fs.statSync(parent)

  if (stat.uid !== uid || stat.mode & 0o022) throw refused()

  return parent
}

export function private_text(file: string, recover_binding = false): string {
  const flags = fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK | fs.constants.O_RDONLY
  const fd = fs.openSync(file, flags)

  try {
    const stat = fs.fstatSync(fd)

    if (stat.uid !== uid || (stat.mode & 0o777) !== 0o600) throw refused()

    if (stat.nlink !== 1 && !(recover_binding && stat.nlink === 2)) throw refused()

    const result = descriptor_read_bounded(fd, 4096)

    if (result.kind !== 'read') throw refused()

    const text = new TextDecoder().decode(result.bytes)

    if (stat.nlink === 2) retire_partial(file, text, fd, stat)

    return text
  } finally {
    fs.closeSync(fd)
  }
}

// Recover exactly the short interval between linking a complete file and retiring its temporary
// name. Never unlink a path unless it is the installer's nonce and the very same inode.
function retire_partial(file: string, text: string, fd: number, stat: fs.Stats): void {
  const install = JSON.parse(text)?.install

  if (typeof install !== 'string' || !/^[0-9a-f-]{36}$/.test(install)) throw refused()

  const temp = path.join(path.dirname(file), `.${install}.partial`)

  if (temp === file) throw refused()

  const other = fs.lstatSync(temp, { throwIfNoEntry: false })

  if (other) {
    if (!other.isFile() || other.dev !== stat.dev || other.ino !== stat.ino) throw refused()

    fs.rmSync(temp, { force: true })
  }

  if (fs.fstatSync(fd).nlink !== 1) throw refused()
}

export function binding_read(file: string): Binding {
  binding_directory(file, false)
  const data = JSON.parse(private_text(file, true)) as Binding | null

  if (
    !data ||
    typeof data.session !== 'string' ||
    !board_id_pattern.test(data.session) ||
    data.session === 'default' ||
    typeof data.owner !== 'string' ||
    !owner_pattern.test(data.owner) ||
    typeof data.token !== 'string' ||
    !credential_pattern.test(data.token)
  )
    throw refused()

  return { session: data.session, owner: data.owner, token: data.token }
}

// Install without replacing even a concurrently created file. Only a complete, private inode
// is ever visible under the requested name. Repeating a link checks, rather than rewrites, it.
export function binding_install(file: string, binding: Binding): void {
  const parent = binding_directory(file, true)
  const install = crypto.randomUUID()
  const temp = path.join(parent, `.${install}.partial`)
  const fd = fs.openSync(temp, 'wx', 0o600)

  try {
    try {
      fs.writeFileSync(fd, JSON.stringify({ ...binding, install }))
      fs.fsyncSync(fd)
    } finally {
      fs.closeSync(fd)
    }

    try {
      fs.linkSync(temp, file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    }
  } finally {
    fs.rmSync(temp, { force: true })
  }

  const installed = binding_read(file)

  if (
    installed.owner !== binding.owner ||
    installed.session !== binding.session ||
    installed.token !== binding.token
  )
    throw refused()

  const dir = fs.openSync(parent, 'r')

  try {
    fs.fsyncSync(dir)
  } finally {
    fs.closeSync(dir)
  }
}
