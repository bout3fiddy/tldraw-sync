// Assertions catch programmer errors. A failed assertion means the mental model of the code is
// wrong, so the only safe response is to stop: the server exits, and a test fails.

export class AssertionError extends Error {
  constructor(message: string) {
    super(`Assertion failed: ${message}`)
    this.name = 'AssertionError'
  }
}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) {
    throw new AssertionError(message)
  }
}

export function unreachable(value: never): never {
  throw new AssertionError(`unreachable: ${String(value)}`)
}
