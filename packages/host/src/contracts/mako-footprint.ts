/** What Mako itself costs this Mac now (`mako:mako-footprint`), for Settings › Diagnostics and the footprint bench. */
export interface MakoFootprint {
  at: string
  /** File attribution is unavailable while its owner is being recovered. */
  attributionFailure?: string
  /** Mako's own processes: the app, its host and helpers, the sync daemon and the watcher children. */
  processes: MakoProcess[]
  /** The agents Mako started, counted apart: their work is the person's, not Mako's. */
  agents: { count: number; cpuPercent: number; residentBytes: number }
  watching: WatchFootprint
  /** Rescans after lost file events; null where this host doesn't keep the record of changes. */
  rescans: RescanFootprint | null
}

export interface MakoProcess {
  pid: number
  /** What it is, in words: "host", "sync daemon", "watcher child". */
  role: string
  /** As `ps` reads it: a decaying average over the last minute. */
  cpuPercent: number
  cpuSeconds: number
  residentBytes: number
}

export interface WatchFootprint {
  /** Folders watched, each with how many of Mako's watches share it. */
  roots: { root: string; watches: number }[]
  /** FSEvents streams the watcher child holds: one per distinct folder and ignore list, and its canary's. */
  streams: number
  child?: { pid?: number; since: number }
  /** The child reading the file system's history, while it runs: it ends after a while without reads. */
  historyChild?: { pid?: number; since: number }
  /** Why the watcher child was started since the host did; `recovery` after fseventsd started over. */
  starts: { first: number; crash: number; silence: number; recovery: number }
  /** How the child's canary hears macOS deliver: `lagMs` is the slowest of its recent beats. */
  delivery: { ok: boolean; lagMs?: number; since: number }
  /** Changed paths delivered to Mako in the last hour. */
  eventsLastHour: number
  /** Times macOS said a watch dropped events in the last hour, and by whom. */
  droppedLastHour: number
  droppedBy: Partial<Record<"client" | "kernel" | "coalesced" | "unsaid", number>>
  /** Reads of the file system's history in the last hour, for turns' footprints and catching up. */
  history: { readsLastHour: number; pathsLastHour: number; slowestMs?: number }
}

export interface RescanFootprint {
  roots: number
  lastHour: number
  filesLastHour: number
  msLastHour: number
  lossesLastHour: number
  /** Roots whose losses keep coming, so Mako checks them less often: how long it now waits between rescans. */
  backedOff: { root: string; everyMs: number }[]
}
