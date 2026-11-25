#!/usr/bin/env bun
// The `tldraw-sync` command. `bun link` in the repository puts it on the PATH, so it runs from
// any folder; every path it uses is relative to the repository, never to the current folder.

import { parseArgs } from 'node:util'
import { assert } from '../shared/assert'
import {
  cleanup_compose, cleanup_publish, cleanup_restore, cleanup_snapshot,
} from './cleanup_commands'
import { fetch_drawing, serve, start, status, stop, type Options } from './commands'
import { commands, help_commands, help_top, type Command } from './help'
import { failure, outcome_print, type Outcome, type OutputMode } from './output'
import { session_create, session_list, session_rename } from './session_commands'
import { board_id_pattern, board_name_clean } from '../shared/board_session'
import { board_name_length_max } from '../shared/constants'
import package_json from '../../package.json'

const options_common = {
  json: { type: 'boolean' },
  quiet: { type: 'boolean', short: 'q' },
  help: { type: 'boolean', short: 'h' },
} as const

// The board session a command works on. Without it, the default board.
const option_session = { session: { type: 'string' } } as const

const options_by_command = {
  start: { ...options_common, port: { type: 'string' }, 'no-open': { type: 'boolean' } },
  fetch: {
    ...options_common, ...option_session, out: { type: 'string' }, 'no-open': { type: 'boolean' },
  },
  status: { ...options_common, ...option_session },
  stop: options_common,
  serve: { ...options_common, port: { type: 'string' } },
  'cleanup-snapshot': {
    ...options_common, ...option_session, out: { type: 'string' }, 'no-open': { type: 'boolean' },
  },
  'cleanup-compose': { ...options_common, file: { type: 'string' }, out: { type: 'string' } },
  'cleanup-publish': { ...options_common, ...option_session, file: { type: 'string' } },
  'cleanup-restore': {
    ...options_common, ...option_session,
    'base-revision': { type: 'string' }, revision: { type: 'string' },
  },
  'session-list': options_common,
  'session-create': { ...options_common, name: { type: 'string' } },
  'session-rename': { ...options_common, ...option_session, name: { type: 'string' } },
} as const

async function main(argv: readonly string[]): Promise<number> {
  const mode: OutputMode = argv.includes('--json') ? 'json'
    : argv.includes('--quiet') || argv.includes('-q') ? 'quiet'
      : 'human'
  const [name, ...rest] = argv

  if (name === undefined || name === 'help' || name === '--help' || name === '-h') {
    const topic = commands.find((command) => command === rest[0])
    console.log(topic === undefined ? help_top : help_commands[topic])
    return 0
  }
  if (name === '--version') {
    console.log(package_json.version)
    return 0
  }
  const command = commands.find((candidate) => candidate === name)
  if (command === undefined) {
    return outcome_print(usage_error(`Unknown command "${name}".`, 'tldraw-sync --help'), mode)
  }

  const parsed = arguments_parse(command, rest)
  if ('outcome' in parsed) return outcome_print(parsed.outcome, mode)
  if (parsed.help) {
    console.log(help_commands[command])
    return 0
  }
  const outcome = await command_run(command, parsed.options)
  const exit_code = outcome_print(outcome, mode)
  // A serving board keeps the process alive; -1 tells the caller not to exit.
  return command === 'serve' && outcome.kind === 'success' ? -1 : exit_code
}

type Parsed = { options: Options; help: boolean } | { outcome: Outcome }

function arguments_parse(command: Command, rest: readonly string[]): Parsed {
  const help_command = `tldraw-sync ${command} --help`
  let values: Record<string, string | boolean | undefined>
  try {
    values = parseArgs({
      args: [...rest],
      options: options_by_command[command],
      allowPositionals: false,
      strict: true,
    }).values as Record<string, string | boolean | undefined>
  } catch (error) {
    const message = (error as Error).message.replace(/\.?$/, '.')
    return { outcome: usage_error(message, help_command) }
  }

  let port: number | null = null
  if (typeof values.port === 'string') {
    port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      const message = '--port must be a whole number from 1 to 65535.'
      return { outcome: usage_error(message, help_command) }
    }
  }
  const base_revision = revision_parse(values['base-revision'])
  const revision = revision_parse(values.revision)
  if (base_revision === 'malformed' || revision === 'malformed') {
    const message = 'A revision must be a whole number from 0 up.'
    return { outcome: usage_error(message, help_command) }
  }
  const session = typeof values.session === 'string' ? values.session : null
  if (session !== null && !board_id_pattern.test(session)) {
    const message = '--session takes an id from session-list: 16 hex digits, or default.'
    return { outcome: usage_error(message, help_command) }
  }
  const name = typeof values.name === 'string'
    ? board_name_clean(values.name, board_name_length_max)
    : null
  if (typeof values.name === 'string' && name === null) {
    const message = `--name takes 1 to ${board_name_length_max} characters on one line.`
    return { outcome: usage_error(message, help_command) }
  }
  const options: Options = {
    port,
    no_open: values['no-open'] === true,
    out: typeof values.out === 'string' ? values.out : null,
    terminal: process.stdout.isTTY === true && values.json !== true && values.quiet !== true,
    file: typeof values.file === 'string' ? values.file : null,
    base_revision,
    revision,
    session,
    name,
  }
  assert(options.port === null || options.port > 0, 'a parsed port is positive')
  return { options, help: values.help === true }
}

function revision_parse(value: string | boolean | undefined): number | null | 'malformed' {
  if (typeof value !== 'string') return null
  const revision = Number(value)
  return /^[0-9]{1,15}$/.test(value) && Number.isSafeInteger(revision) ? revision : 'malformed'
}

function command_run(command: Command, options: Options): Promise<Outcome> {
  if (command === 'start') return start(options)
  if (command === 'cleanup-snapshot') return cleanup_snapshot(options)
  if (command === 'cleanup-compose') return cleanup_compose(options)
  if (command === 'cleanup-publish') return cleanup_publish(options)
  if (command === 'cleanup-restore') return cleanup_restore(options)
  if (command === 'fetch') return fetch_drawing(options)
  if (command === 'status') return status(options)
  if (command === 'session-list') return session_list()
  if (command === 'session-create') return session_create(options)
  if (command === 'session-rename') return session_rename(options)
  if (command === 'stop') return stop()
  assert(command === 'serve', 'every command is dispatched')
  return serve(options)
}

function usage_error(message: string, help_command: string): Outcome {
  return failure('usage_error', message, { action: 'fix_usage', command: help_command })
}

const exit_code = await main(process.argv.slice(2))
if (exit_code >= 0) process.exit(exit_code)
