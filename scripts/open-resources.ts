import { isatty } from "node:tty"

declare global {
  namespace NodeJS {
    interface Process {
      /** The owner of every referenced handle: the only way to tell whose a resource is. Node's own, in no type. */
      _getActiveHandles(): unknown[]
    }
  }
}

/**
 * What holds this process's event loop open, by kind: every referenced handle and timer but its own stdin, stdout
 * and stderr, which never end and are terminals in a shell and pipes on CI. A stream is left out only while its
 * handle is really there: to a file it has none, and stdin at its end has closed its own, so counting the stream
 * would hide someone else's pipe.
 */
export function leftOpen(): string[] {
  // Read first: `process.stdin` opens its handle the first time it's asked for.
  const stdio = [process.stdin, process.stdout, process.stderr]
  const open = process.getActiveResourcesInfo()
  stdio.forEach((stream, fd) => {
    if (!process._getActiveHandles().includes(stream)) return
    const at = open.indexOf(isatty(fd) ? "TTYWrap" : "PipeWrap")
    if (at >= 0) open.splice(at, 1)
  })
  return open
}
