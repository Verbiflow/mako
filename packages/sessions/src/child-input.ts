import type { ChildProcess, Serializable } from "node:child_process"
import type { Writable } from "node:stream"

/**
 * What a process writes to a child it started: its stdin, and its IPC channel. A child that exits as it's written to
 * fails the write with EPIPE, which a stream reports as an `'error'` event; one nobody listens for is thrown, and ends
 * the whole process (the Cursor SDK's client ended a host so, as discovery had: #510). Each write here can fail only
 * its own caller: stdin always has a listener, and an IPC send always has a callback, so neither emits an error
 * nobody hears.
 *
 * Every write to a child's stdin or IPC channel in the host and the sessions daemon goes through here
 * (`scripts/check-child-input.mjs`, in `npm run lint`).
 */

/** A child whose input is gone: it exited, or closed its end. */
export class ChildInputClosedError extends Error {
  constructor(message = "The child's input is closed", options?: ErrorOptions) {
    super(message, options)
    this.name = "ChildInputClosedError"
  }
}

const listened = new WeakSet<Writable>()

/**
 * `child`'s stdin, with a listener for its `'error'`, for code that hands the stream on (a pipe, a web stream). Every
 * write's own callback, or the child's exit, says what failed; the listener only keeps the error from being thrown.
 */
export function childInput<Stdin extends Writable | null>(child: { stdin: Stdin }): Stdin {
  const { stdin } = child
  if (stdin && !listened.has(stdin)) {
    listened.add(stdin)
    stdin.on("error", () => {})
  }
  return stdin
}

/** Writes `chunk` to `child`'s stdin: resolves once it's written, and rejects with `ChildInputClosedError` if it can't be. */
export function writeChildInput(child: Pick<ChildProcess, "stdin">, chunk: string | Uint8Array): Promise<void> {
  const stdin = childInput(child)
  if (!stdin || stdin.destroyed || stdin.writableEnded) return Promise.reject(new ChildInputClosedError())
  return new Promise((resolve, reject) => {
    stdin.write(chunk, (error) => (error ? reject(new ChildInputClosedError(error.message, { cause: error })) : resolve()))
  })
}

/** Ends `child`'s stdin, with `chunk` last when given. A child whose input has already gone is left as it is. */
export function endChildInput(child: Pick<ChildProcess, "stdin">, chunk?: string | Uint8Array): void {
  const stdin = childInput(child)
  if (!stdin || stdin.destroyed || stdin.writableEnded) return
  if (chunk === undefined) stdin.end()
  else stdin.end(chunk)
}

/** Sends `message` on `child`'s IPC channel: resolves once sent, and rejects with `ChildInputClosedError` if the channel has closed. */
export function sendToChild(child: Pick<ChildProcess, "connected" | "send">, message: Serializable): Promise<void> {
  if (!child.connected) return Promise.reject(new ChildInputClosedError("The child's channel is closed"))
  return new Promise((resolve, reject) => {
    // A callback given, Node hands the failure to it rather than emitting `'error'` on the child.
    child.send(message, (error) => (error ? reject(new ChildInputClosedError(error.message, { cause: error })) : resolve()))
  })
}
