import { appOutputReader } from "./thread-app-output"
import { toast } from "sonner"
import { getMako } from "@/lib/bridge"
import { installThreadAppDriver, putAppMarks, putRoom, putThreadApp, targetOf, threadAppStore, type AppPhase, type ThreadAppView } from "@/state/thread-app"
import { deskRefetch, DESK_SCOPE } from "@/state/desk-refetch"
import type { RefetchLease } from "@/lib/view-refetch"
import type { AppActionOutcome } from "@mako/host/contracts/thread-app"

const BUSY_MS = 1_000
const SETTLED_MS = 30_000
const UNAVAILABLE_MS = 60_000
const ASLEEP_MS = 30_000
const ROOM_MS = 4_000
const EXPECT_MS = 6_000
interface Watched {
  count: number
  target?: string
  lease?: RefetchLease
  expected?: { from: AppPhase[]; to: AppPhase; until: number }
}

/** Existing app stores and actions, with one visibility/refetch owner shared with the rest of the desk. */
export function installHostThreadApp(): void {
  const mako = getMako()
  const owner = deskRefetch()
  const watched = new Map<string, Watched>()
  let markWatchers = 0
  let roomWatchers = 0
  let marks: RefetchLease | undefined
  const aim = (cwd: string) => targetOf(threadAppStore.get(), cwd)
  const refresh = (cwd: string) => watched.get(cwd)?.lease?.refresh({ immediate: true, invalidate: true })

  const follow = (cwd: string, entry: Watched) => {
    entry.lease?.release()
    entry.target = aim(cwd)
    const target = entry.target
    entry.lease = owner.reads.watch(JSON.stringify(["host:app", cwd, target]), {
      scope: DESK_SCOPE, domain: "apps", key: cwd, fields: ["state", "checks", "recipe"],
      every: () => {
        const view = threadAppStore.get().byCwd[cwd]
        if (!view) return UNAVAILABLE_MS
        if (view.kind === "asleep") return ASLEEP_MS
        return busy(view) ? owner.appFollowing() ? 2_000 : BUSY_MS : SETTLED_MS
      },
      read: async (current) => {
        let view: ThreadAppView
        try { view = await mako.threadApp(cwd, target) }
        catch (error) { if (current()) putThreadApp(cwd, undefined); throw error }
        if (!current() || target !== aim(cwd)) return
        const expected = entry.expected
        if (expected && view.kind === "ready") {
          if (Date.now() < expected.until && expected.from.includes(view.phase)) view = { ...view, phase: expected.to }
          else entry.expected = undefined
        }
        putThreadApp(cwd, view)
      },
    })
  }
  threadAppStore.subscribe(() => {
    for (const [cwd, entry] of watched) if (entry.target !== aim(cwd)) follow(cwd, entry)
  })

  const act = (cwd: string, to: AppPhase | undefined, run: () => Promise<AppActionOutcome | void>) => {
    const entry = watched.get(cwd)
    const view = threadAppStore.get().byCwd[cwd]
    if (entry && to && view?.kind === "ready") {
      entry.expected = { from: [view.phase, ...(view.phase === "crashed" ? (["stopped"] as const) : [])], to, until: Date.now() + EXPECT_MS }
      putThreadApp(cwd, { ...view, phase: to })
    }
    if (view?.kind === "asleep") putThreadApp(cwd, { ...view, waking: true })
    refresh(cwd)
    Promise.resolve().then(run).then((outcome) => {
      for (const problem of outcome?.problems ?? []) toast.error(problem)
    }).catch((error) => toast.error(error instanceof Error ? error.message : String(error))).finally(() => {
      if (watched.get(cwd) !== entry) return
      if (entry) entry.expected = undefined
      refresh(cwd)
    })
  }

  const followMarks = () => {
    if (marks || (!markWatchers && !roomWatchers)) return
    marks = owner.reads.watch("host:app-list", {
      scope: DESK_SCOPE, domain: "apps", fields: ["state", "room", "checks"],
      every: () => roomWatchers ? owner.appFollowing() ? ROOM_MS : threadAppStore.get().room?.marks.some((mark) => mark.state === "starting") ? BUSY_MS : ROOM_MS : owner.appFollowing() ? undefined : SETTLED_MS,
      read: async (current) => {
        const withRoom = roomWatchers > 0
        const room = withRoom ? await mako.threadAppRoom() : undefined
        const listed = room?.marks ?? await mako.threadAppMarks()
        if (!current() || withRoom !== (roomWatchers > 0)) return
        putAppMarks(listed)
        if (room) putRoom(room)
      },
    })
  }
  const watchLooks = (room: boolean) => {
    const before = roomWatchers
    if (room) roomWatchers++
    else markWatchers++
    followMarks()
    if (room && !before) marks?.refresh({ immediate: true, invalidate: true })
    let stopped = false
    return () => {
      if (stopped) return
      stopped = true
      if (room) roomWatchers--
      else markWatchers--
      if (!markWatchers && !roomWatchers) { marks?.release(); marks = undefined }
      else if (room && !roomWatchers) marks?.refresh({ immediate: true, invalidate: true })
      if (!roomWatchers) putRoom(undefined)
    }
  }

  installThreadAppDriver({
    start: (cwd) => act(cwd, "starting", () => mako.startThreadApp(cwd, aim(cwd))),
    stop: (cwd) => act(cwd, "stopped", () => mako.stopThreadApp(cwd)),
    restart: (cwd) => act(cwd, "starting", () => mako.restartThreadApp(cwd, aim(cwd))),
    makeRoom: (cwd) => act(cwd, "starting", () => mako.makeRoomForThreadApp(cwd, aim(cwd))),
    takeTurn: (cwd) => act(cwd, "starting", () => mako.takeTurnForThreadApp(cwd, aim(cwd))),
    runCheck: (cwd, tier, steps) => {
      const view = threadAppStore.get().byCwd[cwd]
      if (view?.kind === "ready") putThreadApp(cwd, { ...view, checks: view.checks.map((check) => check.tier === tier ? running(check, steps) : check) })
      act(cwd, undefined, () => mako.checkThreadApp(cwd, tier, aim(cwd), steps))
    },
    readOutput: async (cwd, key) => (await mako.threadAppOutput(cwd, key)).text,
    subscribeOutput: appOutputReader(owner, (cwd, key, cursor) => mako.threadAppOutput(cwd, key, cursor)),
    watch: (cwd) => {
      let entry = watched.get(cwd)
      if (entry) entry.count++
      else {
        entry = { count: 1 }
        watched.set(cwd, entry)
        follow(cwd, entry)
        threadAppStore.set({ followed: [...watched.keys()] })
      }
      let stopped = false
      return () => {
        if (stopped) return
        stopped = true
        const current = watched.get(cwd)
        if (!current || --current.count > 0) return
        current.lease?.release()
        watched.delete(cwd)
        threadAppStore.set({ followed: [...watched.keys()] })
      }
    },
    probe: (cwd) => mako.probeThreadApp(cwd),
    setup: (root) => mako.projectAppSetup(root),
    watchMarks: () => watchLooks(false),
    watchRoom: () => watchLooks(true),
    stopApps: async (apps) => {
      try { await mako.stopThreadApps(apps) }
      finally { marks?.refresh({ immediate: true, invalidate: true }); for (const cwd of watched.keys()) refresh(cwd) }
    },
  })
  mako.onEvent((event) => {
    if (event.type === "thread-app-marks") {
      if (markWatchers || roomWatchers) putAppMarks(event.marks)
      // Capable hosts also send scoped hints; old hosts retain their immediate event-driven refresh.
      if (!owner.supports("apps")) for (const cwd of watched.keys()) refresh(cwd)
    } else if (event.type === "cloud-machine") {
      for (const cwd of watched.keys()) refresh(cwd)
    }
  })
}

function running(check: Extract<ThreadAppView, { kind: "ready" }>["checks"][number], steps: string[] | undefined) {
  const next = { ...check, state: "running" as const }
  if (check.steps) next.steps = check.steps.map((step) => !steps || steps.includes(step.name) ? { name: step.name, command: step.command, state: "waiting" as const } : step)
  return next
}
function busy(view: ThreadAppView): boolean {
  return view.kind === "ready" && (view.phase === "preparing" || view.phase === "starting" || view.checks.some((check) => check.state === "running"))
}
