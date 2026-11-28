// `native-stage`: the command line around a native stage of a whole data directory
// (`native_stage.ts`). It works on folders only, never on a running board, and never on the
// data directory in use. It activates nothing.

import { randomBytes } from 'node:crypto'
import path from 'node:path'
import { assert } from '../shared/assert'
import { native_stage, type Blocker, type StageRefusalKind } from '../server/native_stage'
import { data_directory } from './board_process'
import type { Options } from './commands'
import { exit_codes, failure, success, type NextAction, type Outcome } from './output'

const help_command = 'tldraw-sync native-stage --help'

// A person reads the first reasons; --json carries every one.
const blockers_shown_count_max = 20

export function stage_command(options: Options): Outcome {
  const { source, out } = options

  if (source === undefined || out === null) {
    return usage('native-stage needs --source and --out.')
  }

  for (const folder of [source, out]) {
    if (!path.isAbsolute(folder) || path.resolve(folder) !== folder || folder.length > 4096) {
      return usage('--source and --out take plain absolute paths, without . or .. parts.')
    }
  }

  const result = native_stage({
    source_directory: source,
    output_directory: out,
    live_directory: data_directory(),
    id_create: () => randomBytes(8).toString('hex'),
  })

  if (result.kind === 'blocked') return blocked(result.boards_count, result.blockers)

  if (result.kind !== 'staged')
    return failure(result.kind, result.message, next_action(result.kind))

  const quoted = `'${result.output_directory.replaceAll("'", "'\\''")}'`
  const serve_command = `BOARD_DATA_DIR=${quoted} tldraw-sync start`
  const counts = (['converted', 'native', 'empty'] as const).map(
    (kind) => `${result.boards.filter((board) => board.kind === kind).length} ${kind}`,
  )
  const human = [
    `Staged ${result.boards.length} boards as native in ${result.output_directory}:` +
      ` ${counts.join(', ')}. The source was not changed and nothing was activated.`,
    `Earlier Agent canvas revisions are archived as agent_canvas.archive, not restorable.`,
    `Try it: ${serve_command}`,
  ].join('\n')
  assert(result.boards.length > 0, 'a stage holds at least the boards it listed')
  return success('staged', human, result.output_directory, {
    output_directory: result.output_directory,
    boards_count: result.boards.length,
    boards: result.boards,
    registry_carried: result.registry_carried,
    key_carried: result.key_carried,
    operational_skipped: result.operational_skipped,
    source_digest: result.source_digest,
    staged_digest: result.staged_digest,
    native: true,
    activated: false,
    serve_command,
  })
}

function blocked(boards_count: number, blockers: readonly Blocker[]): Outcome {
  assert(blockers.length > 0, 'a blocked stage says why')
  const lines = blockers.slice(0, blockers_shown_count_max).map((reason) => {
    const where = [reason.session ?? 'data directory', reason.file].filter(Boolean).join(' ')
    return `  ${reason.kind} (${where}): ${reason.message}`
  })
  const more = blockers.length - lines.length
  const message = [
    `Nothing was staged: ${blockers.length} reasons stop the stage.`,
    ...lines,
    ...(more > 0 ? [`  and ${more} more, listed with --json.`] : []),
  ].join('\n')
  const action: NextAction = {
    action: 'ask_human',
    message: 'Resolve each reason on the board itself, stop it, copy the data again, and rerun.',
  }
  return failure('blocked', message, action, exit_codes.failure, { boards_count, blockers })
}

function next_action(kind: StageRefusalKind): NextAction {
  if (kind === 'output_exists' || kind === 'output_alias' || kind === 'source_missing') {
    return { action: 'fix_usage', command: help_command }
  }

  if (kind === 'source_active' || kind === 'source_live' || kind === 'source_changed') {
    return {
      action: 'ask_human',
      message: 'Stop the board, copy its data directory, and stage the copy.',
    }
  }

  return { action: 'ask_human', message: 'The stage could not be written; nothing was kept.' }
}

function usage(message: string): Outcome {
  assert(message.endsWith('.'), 'a usage message is a sentence')
  return failure('usage_error', message, { action: 'fix_usage', command: help_command })
}
