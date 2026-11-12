import type { ChildProcess } from "node:child_process"
import { processRunner } from "@mako/git/process-runner"
import { childInput } from "@mako/sessions/child-input"
import { ErrnoFieldsSchema, HelperAskSchema, type HelperSays } from "./git-helper-protocol.js"

/**
 * The host's Git helper (`GitHelper`): one long-lived child that starts the host's `git` processes, so the host's own
 * thread pays no fork and exec for them. Each runs through `@mako/git`'s process runner, as a host spawn does: in a
 * process group of its own, its stop the runner's (the group signalled, then killed, then confirmed gone), its natural
 * end reaped before it's reported. What it writes and how it ends go back to the host as they happen, in order; the
 * host's `Git` reads them as it reads a process of its own.
 */
const running = new Map<number, ChildProcess>()

function say(message: HelperSays): void {
  // The host gone: what's left is ended on disconnect.
  process.send?.(message, undefined, undefined, () => {})
}

process.on("message", (raw) => {
  const ask = HelperAskSchema.parse(raw)
  if (ask.t === "spawn") {
    let child: ChildProcess
    try {
      child = processRunner.spawn(ask.file, ask.args, { cwd: ask.cwd, env: ask.env, stdio: [ask.stdin, "pipe", "pipe"], windowsHide: true })
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error))
      say({ t: "error", id: ask.id, message: failure.message, ...errno(failure) })
      say({ t: "close", id: ask.id, code: null, signal: null })
      return
    }
    running.set(ask.id, child)
    say({ t: "spawned", id: ask.id, pid: child.pid ?? 0 })
    childInput(child)
    child.stdout?.on("data", (chunk: Buffer) => say({ t: "out", id: ask.id, chunk }))
    child.stderr?.on("data", (chunk: Buffer) => say({ t: "err", id: ask.id, chunk }))
    child.on("error", (error: NodeJS.ErrnoException) => say({ t: "error", id: ask.id, message: error.message, ...errno(error) }))
    child.on("close", (code, signal) => {
      // Reaped as the host's runner reaps its own: the group is confirmed gone before the end is said.
      const ended = () => {
        running.delete(ask.id)
        say({ t: "close", id: ask.id, code, signal })
      }
      void processRunner.close(child).then(ended, ended)
    })
    return
  }
  const child = running.get(ask.id)
  if (!child) {
    if (ask.t === "close") say({ t: "closed", id: ask.id })
    return
  }
  if (ask.t === "stdin") childInput(child)?.write(ask.chunk)
  else if (ask.t === "stdin-end") childInput(child)?.end()
  else void processRunner.close(child, ask.signal).then(
    () => say({ t: "closed", id: ask.id }),
    (error: Error) => say({ t: "closed", id: ask.id, error: error.message }))
})

// The host gone (it quit, or it was killed), or this child stopped by its group's signal: nothing here is anyone's
// now, so every git it started ends with it.
const end = () => {
  void Promise.allSettled([...running.values()].map((child) => processRunner.close(child, "SIGKILL"))).then(() => process.exit(0))
}
process.on("disconnect", end)
process.on("SIGTERM", end)

function errno(error: NodeJS.ErrnoException): Pick<Extract<HelperSays, { t: "error" }>, "code" | "errno" | "syscall" | "path"> {
  return ErrnoFieldsSchema.safeParse({ code: error.code, errno: error.errno, syscall: error.syscall, path: error.path }).data ?? {}
}
