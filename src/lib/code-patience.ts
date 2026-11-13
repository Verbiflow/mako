/**
 * How long a piece of the window's code may take to arrive before the piece says it couldn't load: an import still
 * pending this long won't settle (a stalled connection, or Safari leaving a module it failed once pending for good).
 */
export const CODE_PATIENCE_MS = 8_000

/** The code that didn't arrive within `CODE_PATIENCE_MS`. */
export class CodeTooSlowError extends Error {
  constructor(what: string) {
    super(`${what} didn't arrive within ${CODE_PATIENCE_MS / 1000} s`)
    this.name = "CodeTooSlowError"
  }
}

/** `reading`, or a `CodeTooSlowError` once `CODE_PATIENCE_MS` has passed without it. */
export function withPatience<T>(reading: Promise<T>, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<never>((_, fail) => {
    timer = setTimeout(() => fail(new CodeTooSlowError(what)), CODE_PATIENCE_MS)
  })
  return Promise.race([reading, late]).finally(() => clearTimeout(timer))
}
