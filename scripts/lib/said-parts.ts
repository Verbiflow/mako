import { leftOpen } from "../open-resources.ts"

/**
 * A long suite's parts, each said as it ends, and the one that doesn't end named. A suite that prints one line at its
 * end is silent for as long as it runs, so a slow run and a stuck one read the same from outside: on 2026-11-20 the
 * gate stopped two `test:fin-move` runs after 180 s without a word (`run-suite.mjs`'s quiet limit), and all there was
 * to read was a process table. With this each part's time is in the log, a run that's only slow keeps speaking, and
 * one that waits `limitMs` on a part fails there, saying which part, what inside it was waited for (`waitingFor`) and
 * what holds the loop open.
 */
export interface SaidParts {
  /** Runs `run` as the part `what`: said with its time once it ends, and what the suite fails on if it doesn't. */
  part<Result>(what: string, run: () => Promise<Result> | Result): Promise<Result>
  /** Notes a wait inside a part until the function it answers is called, so a part that doesn't end says what for. */
  waitingFor(what: string): () => void
  /** The suite is over: nothing is watched any more. */
  end(): void
}

export interface SaidPartsOptions {
  /** How long one part may run before the suite fails on it. */
  limitMs: number
  /** Run before the process ends on a part that didn't: the suite's own cleanup, which its `finally` won't reach. */
  cleanup?: () => void
  /** Where the lines go, and how the process ends; a test of this passes its own. */
  say?: (line: string) => void
  fail?: (line: string) => void
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`

export function saidParts(suite: string, options: SaidPartsOptions): SaidParts {
  const say = options.say ?? ((line) => console.log(line))
  const fail = options.fail ?? ((line) => {
    console.error(line)
    process.exit(1)
  })
  const open = new Map<string, number>()
  const waits = new Map<symbol, { what: string; since: number }>()
  // Referenced: with nothing else left on the loop, a part that waits on a promise nobody will settle is still named.
  const watch = setInterval(() => {
    const now = performance.now()
    const late = [...open].filter(([, since]) => now - since > options.limitMs)
    if (!late.length) return
    clearInterval(watch)
    const others = [...open].filter(([what]) => !late.some(([name]) => name === what))
    const lines = [
      `${suite}: waited ${seconds(options.limitMs)} on ${late.map(([what]) => what).join(", ")}, which ${late.length > 1 ? "haven't" : "hasn't"} ended`,
      ...(others.length ? [`  also running: ${others.map(([what, since]) => `${what} (${seconds(now - since)})`).join(", ")}`] : []),
      `  waiting for: ${[...waits.values()].map(({ what, since }) => `${what} (${seconds(now - since)})`).join(", ") || "nothing it names"}`,
      `  the loop is held by: ${leftOpen().join(", ") || "nothing"}`,
    ]
    try {
      options.cleanup?.()
    } finally {
      fail(lines.join("\n"))
    }
  }, 1_000)
  return {
    async part(what, run) {
      const since = performance.now()
      open.set(what, since)
      try {
        const result = await run()
        say(`${suite}: ${what} in ${seconds(performance.now() - since)}`)
        return result
      } finally {
        open.delete(what)
      }
    },
    waitingFor(what) {
      const key = Symbol(what)
      waits.set(key, { what, since: performance.now() })
      return () => { waits.delete(key) }
    },
    end() {
      clearInterval(watch)
    },
  }
}
