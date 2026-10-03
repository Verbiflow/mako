import { toast } from "sonner"
import { getMako } from "@/lib/bridge"
import { installThreadAppDriver, putAppMarks, putThreadApp, threadAppStore, type AppPhase, type ThreadAppView } from "@/state/thread-app"
import type { AppActionOutcome, AppOutputCursor } from "../../electron/contracts/thread-app"

/** While something is changing, the control follows it closely; otherwise it looks now and then. */
const BUSY_MS = 1_000
const SETTLED_MS = 4_000
const HIDDEN_MS = 15_000
/** A host that can't answer (an older one, or no Thread store) isn't asked again soon. */
const UNAVAILABLE_MS = 60_000
const OUTPUT_MS = 500
/** A read this long stopped at the host's limit, so there is more to read straight away. */
const FULL_READ_CHARS = 128 * 1024
/** How long a click's phase stands while the host hasn't caught up with it yet. */
const EXPECT_MS = 6_000

interface Watched {
  count: number
  look: number
  timer?: ReturnType<typeof setTimeout>
  /** Set by an action: the phase it leaves, the one it leads to, and until when to wait for the host. */
  expected?: { from: AppPhase[]; to: AppPhase; until: number }
}

/** The strip and the terminal dock, driven by the host's view of each folder's app. */
export function installHostThreadApp(): void {
  const mako = getMako()
  const watched = new Map<string, Watched>()

  const schedule = (cwd: string, ms: number) => {
    const entry = watched.get(cwd)
    if (!entry) return
    clearTimeout(entry.timer)
    entry.timer = setTimeout(() => void refresh(cwd), ms)
  }

  const refresh = async (cwd: string) => {
    const entry = watched.get(cwd)
    if (!entry) return
    const look = ++entry.look
    clearTimeout(entry.timer)
    const current = () => watched.get(cwd) === entry && entry.look === look
    let view: ThreadAppView | undefined
    try {
      view = await mako.threadApp(cwd)
    } catch {
      if (!current()) return
      putThreadApp(cwd, undefined)
      schedule(cwd, UNAVAILABLE_MS)
      return
    }
    if (!current()) return
    const expected = entry.expected
    if (expected && view.kind === "ready") {
      if (Date.now() < expected.until && expected.from.includes(view.phase)) view = { ...view, phase: expected.to }
      else entry.expected = undefined
    }
    putThreadApp(cwd, view)
    schedule(cwd, document.visibilityState === "hidden" ? HIDDEN_MS : busy(view) ? BUSY_MS : SETTLED_MS)
  }

  /** Shows the phase a click leads to at once, then carries it out and says what went wrong, if anything. */
  const act = (cwd: string, to: AppPhase | undefined, run: () => Promise<AppActionOutcome | void>) => {
    const entry = watched.get(cwd)
    const view = threadAppStore.get().byCwd[cwd]
    if (entry) entry.look += 1
    if (entry && to && view?.kind === "ready") {
      entry.expected = { from: [view.phase, ...(view.phase === "crashed" ? (["stopped"] as const) : [])], to, until: Date.now() + EXPECT_MS }
      putThreadApp(cwd, { ...view, phase: to })
    }
    schedule(cwd, 300)
    Promise.resolve()
      .then(run)
      .then((outcome) => {
        for (const problem of outcome?.problems ?? []) toast.error(problem)
      })
      .catch((error) => toast.error(error instanceof Error ? error.message : String(error)))
      .finally(() => {
        const settled = watched.get(cwd)
        if (settled !== entry) return
        if (settled) settled.expected = undefined
        void refresh(cwd)
      })
  }

  /** The sidebar's marks: one look at every app on this Mac, closer while one is starting. */
  let markWatchers = 0
  let markTimer: ReturnType<typeof setTimeout> | undefined
  /** Bumped whenever a look starts over, so an older answer still on its way neither lands nor schedules another. */
  let markLook = 0
  const refreshMarks = async () => {
    clearTimeout(markTimer)
    const look = ++markLook
    let wait = SETTLED_MS
    try {
      const marks = await mako.threadAppMarks()
      if (look !== markLook || !markWatchers) return
      putAppMarks(marks)
      if (marks.some((mark) => mark.state === "starting")) wait = BUSY_MS
    } catch {
      if (look !== markLook || !markWatchers) return
      putAppMarks([])
      wait = UNAVAILABLE_MS
    }
    markTimer = setTimeout(() => void refreshMarks(), document.visibilityState === "hidden" ? HIDDEN_MS : wait)
  }

  installThreadAppDriver({
    start: (cwd) => act(cwd, "starting", () => mako.startThreadApp(cwd)),
    stop: (cwd) => act(cwd, "stopped", () => mako.stopThreadApp(cwd)),
    restart: (cwd) => act(cwd, "starting", () => mako.restartThreadApp(cwd)),
    makeRoom: (cwd) => act(cwd, "starting", () => mako.makeRoomForThreadApp(cwd)),
    takeTurn: (cwd) => act(cwd, "starting", () => mako.takeTurnForThreadApp(cwd)),
    runCheck: (cwd, tier) => {
      const view = threadAppStore.get().byCwd[cwd]
      if (view?.kind === "ready")
        putThreadApp(cwd, { ...view, checks: view.checks.map((check) => (check.tier === tier ? { ...check, state: "running" } : check)) })
      act(cwd, undefined, () => mako.checkThreadApp(cwd, tier))
    },
    readOutput: async (cwd, key) => (await mako.threadAppOutput(cwd, key)).text,
    subscribeOutput: (cwd, key, listener) => {
      let cursor: AppOutputCursor | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let closed = false
      const read = async () => {
        let more = false
        try {
          const chunk = await mako.threadAppOutput(cwd, key, cursor)
          if (closed) return
          if (chunk.reset || !cursor) listener(chunk.text, true)
          else if (chunk.text) listener(chunk.text, false)
          more = chunk.text.length >= FULL_READ_CHARS
          cursor = chunk.cursor
        } catch {
          // The next read tries again; a folder that's gone reads as empty.
        }
        if (!closed) timer = setTimeout(() => void read(), more ? 0 : OUTPUT_MS)
      }
      void read()
      return () => {
        closed = true
        clearTimeout(timer)
      }
    },
    watch: (cwd) => {
      const entry = watched.get(cwd)
      if (entry) entry.count += 1
      else {
        watched.set(cwd, { count: 1, look: 0 })
        threadAppStore.set({ followed: [...watched.keys()] })
        void refresh(cwd)
      }
      return () => {
        const current = watched.get(cwd)
        if (!current || --current.count > 0) return
        clearTimeout(current.timer)
        watched.delete(cwd)
        threadAppStore.set({ followed: [...watched.keys()] })
      }
    },
    setup: (root) => mako.projectAppSetup(root),
    allowSecrets: async (root, allow) => {
      const setup = await mako.allowProjectSecrets(root, allow)
      for (const cwd of watched.keys()) schedule(cwd, 0)
      return setup
    },
    watchMarks: () => {
      if (++markWatchers === 1) void refreshMarks()
      let released = false
      return () => {
        if (released) return
        released = true
        if (--markWatchers > 0) return
        clearTimeout(markTimer)
        markLook += 1
      }
    },
  })

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return
    for (const cwd of watched.keys()) schedule(cwd, 0)
    if (markWatchers) void refreshMarks()
  })
}

function busy(view: ThreadAppView): boolean {
  if (view.kind !== "ready") return false
  return view.phase === "preparing" || view.phase === "starting" || view.checks.some((check) => check.state === "running")
}
