import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawnProviderProcess } from "./provider-process.js"
import { basename } from "node:path"
import { environmentForExecutable, resolveExecutable } from "../executable.js"

interface DiscoveryOptions {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
  priority?: "launch" | "background"
}

interface DiscoveryProcess {
  child: ChildProcessWithoutNullStreams
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  phase(name: string): void
}

type Priority = NonNullable<DiscoveryOptions["priority"]>
const pending = {
  launch: new Array<() => void>(),
  background: new Array<() => void>(),
} satisfies Record<Priority, Array<() => void>>
let active = 0
let background = 0

function available(priority: Priority): boolean {
  return active < 4 && (priority === "launch" || background < 3)
}
function reserve(priority: Priority): void {
  active++
  if (priority === "background") background++
}
function releaseSlot(priority: Priority): void {
  active--
  if (priority === "background") background--
  for (const next of ["launch", "background"] satisfies Priority[]) {
    while (available(next)) {
      const resume = pending[next].shift()
      if (!resume) break
      reserve(next)
      resume()
    }
  }
}

export async function withDiscoveryProcess<T>(
  options: DiscoveryOptions,
  run: (process: DiscoveryProcess) => Promise<T>
): Promise<T> {
  const requestedAt = performance.now()
  const executable = resolveExecutable(options.command, options.env)
  const label = basename(options.command)
  if (!executable) throw new Error(`${label} is not installed`)
  const queuedAt = performance.now()
  const priority = options.priority ?? "background"
  if (available(priority)) reserve(priority)
  else {
    if (pending.launch.length + pending.background.length >= 64)
      throw new Error("Provider discovery queue is full")
    await new Promise<void>((resolve) => pending[priority].push(resolve))
  }
  const startedAt = performance.now()
  let release: (() => Promise<void>) | undefined
  try {
    const grouped = process.platform !== "win32"
    const child = spawnProviderProcess(executable, options.args, {
      cwd: options.cwd,
      env: environmentForExecutable(executable, options.env),
      detached: grouped,
      windowsHide: true,
    })
    return await new Promise<T>((resolve, reject) => {
      let phase = "startup"
      let bytes = 0
      const exited = new Promise<{
        code: number | null
        signal: NodeJS.Signals | null
      }>((resolve) => {
        child.once("close", (code, signal) => resolve({ code, signal }))
      })
      const fail = (error: Error) => reject(error)
      child.on("error", fail)
      child.stdin.on("error", fail)
      child.stdout.on("error", fail)
      child.stderr.on("error", fail)
      child.stderr.resume()
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length
        if (bytes > 8_000_000) {
          fail(new Error(`${label} discovery response exceeded 8 MB`))
          child.stdout.destroy()
        }
      })
      const timeout = options.timeoutMs ?? 30_000
      const timer = setTimeout(
        () =>
          fail(
            new Error(
              `${label} discovery timed out during ${phase} after ${timeout} ms`
            )
          ),
        timeout
      )
      const terminate = (signal: NodeJS.Signals) => {
        if (grouped && child.pid) {
          try {
            process.kill(-child.pid, signal)
            return
          } catch (error) {
            if (
              !(error instanceof Error) ||
              !("code" in error) ||
              (error.code !== "ESRCH" && error.code !== "EPERM")
            )
              throw error
          }
        }
        child.kill(signal)
      }
      release = async () => {
        clearTimeout(timer)
        try {
          await new Promise<void>((resolve, reject) => {
            if (child.exitCode === null && child.signalCode === null)
              terminate("SIGTERM")
            const force = setTimeout(() => {
              try {
                terminate("SIGKILL")
              } catch (error) {
                reject(error)
              }
            }, 1_000)
            void exited.then(() => {
              clearTimeout(force)
              resolve()
            })
          })
        } finally {
          child.stdin.destroy()
          child.stdout.destroy()
          child.stderr.destroy()
        }
      }
      Promise.resolve()
        .then(() =>
          run({
            child,
            exited,
            phase: (name) => {
              phase = name
            },
          })
        )
        .then(resolve, reject)
    })
  } finally {
    try {
      await release?.()
    } finally {
      releaseSlot(priority)
      if (options.env.MAKO_STARTUP_TRACE === "1")
        console.info(
          "[mako-startup]",
          JSON.stringify({
            stage: "discovery",
            command: label,
            resolveMs: queuedAt - requestedAt,
            queuedMs: startedAt - queuedAt,
            elapsedMs: performance.now() - startedAt,
          })
        )
    }
  }
}
