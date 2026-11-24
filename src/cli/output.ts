// Every command ends in exactly one outcome, printed one of three ways:
//
//   default   a sentence for a person
//   --quiet   one bare value on stdout, for piping
//   --json    one JSON object on stdout, for agents
//
// A failure always carries the next action, so whoever reads it, person or agent, knows what
// to do without guessing.

import { assert } from '../shared/assert'

export const exit_codes = {
  success: 0,
  failure: 1,
  not_running: 2,
  board_empty: 3,
  not_ready: 4,
} as const

export type ExitCode = (typeof exit_codes)[keyof typeof exit_codes]

export type NextAction =
  | { action: 'run'; command: string }
  | { action: 'retry'; command: string }
  | { action: 'ask_human'; message: string }
  | { action: 'fix_usage'; command: string }

export type Outcome =
  | {
      kind: 'success'
      code: string
      human: string
      quiet: string
      data: Record<string, unknown>
    }
  | {
      kind: 'failure'
      code: string
      message: string
      next_action: NextAction
      exit_code: Exclude<ExitCode, 0>
    }

export type OutputMode = 'human' | 'quiet' | 'json'

export function success(
  code: string,
  human: string,
  quiet: string,
  data: Record<string, unknown>,
): Outcome {
  assert(/^[a-z_]+$/.test(code), 'a code is snake_case')
  return { kind: 'success', code, human, quiet, data }
}

export function failure(
  code: string,
  message: string,
  next_action: NextAction,
  exit_code: Exclude<ExitCode, 0> = exit_codes.failure,
): Outcome {
  assert(/^[a-z_]+$/.test(code), 'a code is snake_case')
  assert(message.endsWith('.'), 'a message is a full sentence')
  return { kind: 'failure', code, message, next_action, exit_code }
}

// Prints the outcome and returns the exit code for it.
export function outcome_print(outcome: Outcome, mode: OutputMode): ExitCode {
  if (outcome.kind === 'success') {
    if (mode === 'json') {
      line_write({ status: 'success', code: outcome.code, ...outcome.data })
    } else if (mode === 'quiet') {
      if (outcome.quiet.length > 0) process.stdout.write(`${outcome.quiet}\n`)
    } else {
      process.stdout.write(`${outcome.human}\n`)
    }
    return exit_codes.success
  }

  if (mode === 'json') {
    line_write({
      status: 'failure',
      code: outcome.code,
      message: outcome.message,
      next_action: outcome.next_action,
      exit_code: outcome.exit_code,
    })
  } else {
    process.stderr.write(`${outcome.message}\nNext: ${next_action_text(outcome.next_action)}\n`)
  }
  return outcome.exit_code
}

function next_action_text(next_action: NextAction): string {
  if (next_action.action === 'ask_human') return next_action.message
  if (next_action.action === 'fix_usage') return `see ${next_action.command}`
  return `run ${next_action.command}`
}

function line_write(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`)
}
