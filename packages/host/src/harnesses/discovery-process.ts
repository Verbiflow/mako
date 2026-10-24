import type { ChildProcessWithoutNullStreams } from "node:child_process"
import { spawnProviderProcess } from "./provider-process.js"
import { basename } from "node:path"
import { environmentForExecutable, resolveExecutable } from "../base/executable.js"
import { onWindows } from "../base/platform.js"

export interface DiscoveryOptions {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  cwd?: string
  timeoutMs?: number
  priority?: "launch" | "background"
  /**
   * When `timeoutMs` starts counting. `queued` (the default) bounds the whole
   * query, for discovery that answers from its last snapshot meanwhile.
   * `started` bounds only the process, for a reading nothing stands in for:
   * a version or a sign-in check waits its turn instead of failing behind
   * slower discovery. The wait stays bounded, because every slot's own process is.
   */
  deadline?: "queued" | "started"
  /** Cancellation belongs to this query; never terminates another slot's child. */
  signal?: AbortSignal
}

export interface DiscoveryProcess {
  child: ChildProcessWithoutNullStreams
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>
  phase(name: string): void
}

type Priority = NonNullable<DiscoveryOptions["priority"]>

/**
 * The provider CLIs a host runs to discover settings, accounts and versions:
 * four at once, three of them in the background, sixty-four waiting.
 */
export class DiscoveryProcesses {
  private readonly pending = { launch: new Array<() => void>(), background: new Array<() => void>() }
  private active = 0
  private background = 0

  private available(priority: Priority): boolean {
    return this.active < 4 && (priority === "launch" || this.background < 3)
  }

  private reserve(priority: Priority): void {
    this.active++
    if (priority === "background") this.background++
  }

  private releaseSlot(priority: Priority): void {
    this.active--
    if (priority === "background") this.background--
    for (const next of ["launch", "background"] satisfies Priority[]) {
      while (this.available(next)) {
        const resume = this.pending[next].shift()
        if (!resume) break
        this.reserve(next)
        resume()
      }
    }
  }

  async run<T>(
    options: DiscoveryOptions,
    run: (process: DiscoveryProcess) => Promise<T>
  ): Promise<T> {
    const requestedAt = performance.now()
    const executable = resolveExecutable(options.command, options.env)
    const label = basename(options.command)
    if (!executable) throw new Error(`${label} is not installed`)
    const queuedAt = performance.now()
    const priority = options.priority ?? "background"
    const timeout = options.timeoutMs ?? 30_000
    options.signal?.throwIfAborted()
    if (this.available(priority)) this.reserve(priority)
    else {
      if (this.pending.launch.length + this.pending.background.length >= 64)
        throw new Error("Provider discovery queue is full")
      await new Promise<void>((resolve, reject) => {
        const queue = this.pending[priority]
        const cleanup = () => {
          clearTimeout(timer)
          options.signal?.removeEventListener("abort", abort)
        }
        const resume = () => { cleanup(); resolve() }
        const refuse = (error: Error) => {
          const index = queue.indexOf(resume)
          if (index < 0) return
          queue.splice(index, 1)
          cleanup()
          reject(error)
        }
        const abort = () => {
          const reason: unknown = options.signal?.reason
          refuse(reason instanceof Error ? reason : new Error("Provider discovery was cancelled"))
        }
        const timer = options.deadline === "started"
          ? undefined
          : setTimeout(() => refuse(new Error(`${label} discovery timed out in the queue after ${timeout} ms`)), timeout)
        queue.push(resume)
        options.signal?.addEventListener("abort", abort, { once: true })
      })
    }
    const startedAt = performance.now()
    const waited = options.deadline === "started" ? 0 : startedAt - queuedAt
    let release: (() => Promise<void>) | undefined
    try {
      options.signal?.throwIfAborted()
      if (waited >= timeout)
        throw new Error(`${label} discovery timed out in the queue after ${timeout} ms`)
      const grouped = !onWindows()
      // Recorded as holding no session, so a harness that can't tell which session a process holds counts it as Mako's.
      const child = spawnProviderProcess(executable, options.args, {
        cwd: options.cwd,
        env: environmentForExecutable(executable, options.env),
        detached: grouped,
        windowsHide: true,
      }, { kind: "discovery", owner: label, session: null })
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
        const timer = setTimeout(
          () =>
            fail(
              new Error(
                `${label} discovery timed out during ${phase} after ${timeout} ms`
              )
            ),
          Math.max(0, timeout - waited)
        )
        const abort = () => reject(options.signal?.reason)
        options.signal?.addEventListener("abort", abort, { once: true })
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
          options.signal?.removeEventListener("abort", abort)
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
        this.releaseSlot(priority)
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
}
