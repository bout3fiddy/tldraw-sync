// `native-rehearse`: the command line around a native rehearsal (`native_rehearsal.ts`). It
// works on folders only, never on a running board, and never on the data directory in use.

import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { assert } from '../shared/assert'
import { native_rehearse, type RehearsalRefusalKind } from '../server/native_rehearsal'
import { data_directory } from './board_process'
import type { Options } from './commands'
import { failure, success, type NextAction, type Outcome } from './output'

const help_command = 'tldraw-sync native-rehearse --help'

export function rehearse_command(options: Options): Outcome {
  const { source, out, session } = options

  if (source === undefined || out === null || session === null) {
    return usage('native-rehearse needs --source, --session and --out.')
  }

  for (const folder of [source, out]) {
    if (!path.isAbsolute(folder) || path.resolve(folder) !== folder || folder.length > 4096) {
      return usage('--source and --out take plain absolute paths, without . or .. parts.')
    }
  }

  const result = native_rehearse({
    source_directory: source,
    session,
    output_directory: out,
    live_directory: data_directory(),
    id_create: () => randomBytes(8).toString('hex'),
  })

  if (result.kind !== 'rehearsed') {
    return failure(result.kind, result.message, next_action(result.kind))
  }

  assert(result.session === session, 'the copy keeps the board id')
  const quoted = `'${result.output_directory.replaceAll("'", "'\\''")}'`
  const serve_command = `BOARD_DATA_DIR=${quoted} tldraw-sync start`
  const human = [
    `Rehearsed board ${session} as native in ${result.output_directory}.`,
    `${result.agent_records_count} Agent canvas records joined ${result.sketch_records_count}` +
      ' sketch records. The source was not changed.',
    `Try it: ${serve_command}`,
  ].join('\n')
  return success('rehearsed', human, result.output_directory, {
    session,
    output_directory: result.output_directory,
    sketch_records_count: result.sketch_records_count,
    agent_records_count: result.agent_records_count,
    agent_revision: result.agent_revision,
    agent_history_count: result.agent_history_count,
    chat_events_count: result.chat_events_count,
    native: true,
    serve_command,
  })
}

function next_action(kind: RehearsalRefusalKind): NextAction {
  if (kind === 'output_exists' || kind === 'output_alias' || kind === 'board_default') {
    return { action: 'fix_usage', command: help_command }
  }

  if (kind === 'source_active' || kind === 'source_live' || kind === 'source_changed') {
    return {
      action: 'ask_human',
      message: 'Stop the board, copy its data directory, and rehearse on the copy.',
    }
  }

  return { action: 'ask_human', message: 'This board cannot be rehearsed as native yet.' }
}

function usage(message: string): Outcome {
  assert(message.endsWith('.'), 'a usage message is a sentence')
  return failure('usage_error', message, { action: 'fix_usage', command: help_command })
}
