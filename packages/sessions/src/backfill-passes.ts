import type { ChildProcess } from "node:child_process"
import type { LogFields, LogLevel } from "./process-log.js"

/** The serving sync daemon's backfill passes (`daemon-main.ts`): begun once discovery is in, ended when it stops. */
export interface BackfillPasses {
  /** Start a pass now and one `everyMs` after each ends, never two at once. Nothing, once stopped. */
  start(): void
  /** Start no more, and end the one running. Holds whenever it's said: a `start` after it starts nothing. */
  stop(): void
}

/**
 * The record store's backfill passes, each a process of its own (`spawnPass`). They are made before discovery and
 * started when it resolves, so a stop that lands first (a SIGTERM while the scan is still out) is the passes' too:
 * the scan a stopping catalog still awaits resolved afterwards, and its pass outlived the daemon that started it.
 */
export function backfillPasses(options: {
  spawnPass: () => ChildProcess
  everyMs: number
  say: (level: LogLevel, message: string, fields?: LogFields) => void
}): BackfillPasses {
  let child: ChildProcess | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let started = false
  let stopped = false
  const run = () => {
    timer = undefined
    if (stopped) return
    const pass = options.spawnPass()
    child = pass
    const at = Date.now()
    let over = false
    // A process that fails after it spawned says both `error` and `exit`: one next pass all the same.
    const ended = () => {
      if (over) return
      over = true
      if (child === pass) child = undefined
      if (stopped) return
      timer = setTimeout(run, options.everyMs)
      timer.unref?.()
    }
    pass.once("exit", (code, signal) => {
      options.say(code === 0 ? "info" : "warn", "backfill pass ended", { pid: pass.pid, code, signal, ms: Date.now() - at })
      ended()
    })
    pass.once("error", (error) => {
      options.say("warn", "the backfill couldn't start", { error: error.message })
      ended()
    })
  }
  return {
    start() {
      if (started || stopped) return
      started = true
      run()
    },
    stop() {
      stopped = true
      if (timer) clearTimeout(timer)
      timer = undefined
      child?.kill("SIGTERM")
    },
  }
}
