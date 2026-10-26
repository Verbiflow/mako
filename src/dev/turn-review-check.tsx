import { createRoot } from "react-dom/client"
import type { LiveSnapshot } from "@mako/host/contracts/live-conversations"
import { TURN_CHANGES_VERSION, type TurnChangedFile, type TurnChanges } from "@mako/host/contracts/turn-changes"
import type { TurnUndoPreview, TurnWriter, WriterRun } from "@mako/host/contracts/turn-review"
import { ChangesPanel } from "@/components/inspector/changes-panel"
import { WorkspaceFocusContext } from "@/components/stage/workspace-focus-context"
import { TooltipProvider } from "@/components/ui/tooltip"
import type { GitDiff, GitFile, GitStatus } from "@/lib/types"
import { acpStore } from "@/state/acp"
import { applyLiveSnapshot } from "@/state/live-recovery"
import { bindTheme, prefsStore } from "@/state/prefs"
import { reviewTurn } from "@/state/review-scope"
import { store, useSession } from "@/state/session"
import { threadsStore } from "@/state/thread-store"
import { threadTitlesStore } from "@/state/thread-titles"
import { workspaceTransitionStore } from "@/state/workspace-transition"
import { fixtureHarnesses } from "./harness-fixtures"
import { installMockBridge } from "./mock-bridge"
import { META } from "./mock-fixtures"
import "../index.css"

/*
 * Changes › Turn and "Undo this turn" over a fixture: turn 2 of 3 of a
 * conversation added retries to a fetch helper, while the person changed a
 * timeout and another Thread moved the logger, in the same file. Each line
 * below is tagged with who wrote it, as the journal's walk would, and the
 * bridge answers the turn's files, diffs, writers and undo from them.
 * `scripts/turn-review-screenshots.mjs` drives it; `?theme=dark` draws dark.
 */

const mock = installMockBridge()
const ROOT = "/work/relay"
const id = "7a1f0c2e-5b44-4c1a-9d0e-3f6b8a2c1d90"
const turns = [
  { id: "7a1f0c2e-0001-4c1a-9d0e-3f6b8a2c1d90", text: "Add a typed fetchJson helper for the API client" },
  { id: "7a1f0c2e-0002-4c1a-9d0e-3f6b8a2c1d90", text: "Retry failed requests with exponential backoff, but never retry a 4xx" },
  { id: "7a1f0c2e-0003-4c1a-9d0e-3f6b8a2c1d90", text: "Write tests for the retry policy" },
]
const OTHER = "c3d4e5f6-0000-4aaa-8bbb-telemetry000"

/** One line of a file across the turn: there before (no `by`), written by someone, and perhaps taken out by someone. */
interface Line {
  text: string
  by?: TurnWriter
  thread?: string
  gone?: TurnWriter
  goneThread?: string
}
const pre = (text: string): Line => ({ text })
const add = (by: TurnWriter, ...texts: string[]): Line[] => texts.map((text) => ({ text, by, ...(by === "other" && { thread: OTHER }) }))
const out = (gone: TurnWriter, ...texts: string[]): Line[] => texts.map((text) => ({ text, gone, ...(gone === "other" && { goneThread: OTHER }) }))

interface FixtureFile {
  kind: TurnChangedFile["kind"]
  lines: Line[]
}

const FILES = new Map<string, FixtureFile>(Object.entries({
  "src/net/fetch-retry.ts": {
    kind: "modify",
    lines: [
      ...out("other", `import { log } from "../log"`),
      ...add("other", `import { log } from "../telemetry/log"`),
      pre(`import type { RequestOptions } from "./client"`),
      ...add("turn", `import { backoff, isRetryable } from "./backoff"`),
      pre(""),
      ...out("person", "const TIMEOUT_MS = 10_000"),
      ...add("person", "const TIMEOUT_MS = 15_000"),
      ...add("turn", "const RETRIES = 3"),
      pre(""),
      pre("/** GET `url` as JSON, retrying a failure the server may recover from. */"),
      pre("export async function fetchJson<T>(url: string, options: RequestOptions = {}): Promise<T> {"),
      ...out("turn",
        "  const controller = new AbortController()",
        "  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)",
        "  try {",
        "    const response = await fetch(url, { ...options, signal: controller.signal })",
        "    if (!response.ok) {",
        `      log.warn("request failed", { url, status: response.status })`,
        "      throw new Error(`Request failed: ${response.status}`)",
        "    }",
        "    return (await response.json()) as T",
        "  } finally {",
        "    clearTimeout(timer)",
        "  }",
      ),
      ...add("turn",
        "  for (let attempt = 1; ; attempt++) {",
        "    const controller = new AbortController()",
        "    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? TIMEOUT_MS)",
        "    try {",
        "      const response = await fetch(url, { ...options, signal: controller.signal })",
        "      if (response.ok) return (await response.json()) as T",
        "      if (attempt > (options.retries ?? RETRIES) || !isRetryable(response.status)) {",
        `        log.warn("request failed", { url, status: response.status, attempt })`,
        "        throw new Error(`Request failed: ${response.status}`)",
        "      }",
        "    } finally {",
        "      clearTimeout(timer)",
        "    }",
        "    await backoff(attempt)",
        "  }",
      ),
      pre("}"),
    ],
  },
  "src/net/backoff.ts": {
    kind: "create",
    lines: add("turn",
      "/** Waits before attempt `attempt + 1`: 200 ms, then doubling, with jitter, capped at 5 s. */",
      "export function backoff(attempt: number): Promise<void> {",
      "  const base = Math.min(5_000, 200 * 2 ** (attempt - 1))",
      "  const wait = base / 2 + Math.random() * (base / 2)",
      "  return new Promise((resolve) => setTimeout(resolve, wait))",
      "}",
      "",
      "/** A status worth another try: the server's trouble, never the request's. */",
      "export function isRetryable(status: number): boolean {",
      "  return status === 408 || status === 429 || status >= 500",
      "}",
    ),
  },
  "src/net/client.ts": {
    kind: "modify",
    lines: [
      pre("export interface RequestOptions extends RequestInit {"),
      pre("  /** Abort after this long; the helper's default otherwise. */"),
      pre("  timeoutMs?: number"),
      ...add("turn", "  /** Tries after the first, for failures worth another try. */", "  retries?: number"),
      pre("}"),
      pre(""),
      pre("export const API_BASE = process.env.RELAY_API ?? \"https://api.relay.dev\""),
      ...out("other", `export const USER_AGENT = "relay-web"`),
      ...add("other", "export const USER_AGENT = `relay-web/${__VERSION__}`"),
    ],
  },
  "docs/networking.md": {
    kind: "modify",
    lines: [
      pre("## Requests"),
      pre(""),
      pre("Every call goes through `fetchJson`, which times out after 15 seconds."),
      ...add("maybe", "", "A request that fails with a 408, a 429 or a 5xx is tried again up to three times,", "waiting longer each time. A 4xx other than those never is."),
    ],
  },
} satisfies Record<string, FixtureFile>))

const text = (lines: readonly Line[]) => lines.map((line) => `${line.text}\n`).join("")
const before = (lines: readonly Line[]) => text(lines.filter((line) => !line.by))
const after = (lines: readonly Line[]) => text(lines.filter((line) => !line.gone))
/** With only the turn's own lines changed: everyone else's on both sides. */
const onlyBefore = (lines: readonly Line[]) => text(lines.filter((line) => (line.gone ? line.gone === "turn" && line.by !== "turn" : line.by !== "turn")))

function runsOf(lines: readonly Line[]): WriterRun[] {
  const runs: WriterRun[] = []
  let old = 0
  let now = 0
  const push = (side: WriterRun["side"], line: number, writer: TurnWriter, thread?: string) => {
    const last = runs.findLast((run) => run.side === side)
    if (last && last.start + last.length === line && last.writer === writer && last.thread === thread) last.length++
    else runs.push({ side, start: line, length: 1, writer, ...(thread && { thread }) })
  }
  for (const line of lines) {
    if (!line.by) old++
    if (!line.gone) now++
    if (line.gone) push("deletions", old, line.gone, line.goneThread)
    else if (line.by) push("additions", now, line.by, line.thread)
  }
  return runs
}

function count(lines: readonly Line[], who: "turn" | "maybe") {
  return { added: lines.filter((line) => !line.gone && line.by === who).length, removed: lines.filter((line) => !line.by && line.gone === who).length }
}

const ref = (fill: string) => `sha256:${fill.repeat(64)}`
const record: TurnChanges = (() => {
  // By path, as the journal's count lists them.
  const files = [...FILES].sort(([a], [b]) => a.localeCompare(b)).map(([relative, file], index): TurnChangedFile => {
    const own = count(file.lines, "turn")
    const maybe = count(file.lines, "maybe")
    return {
      path: `${ROOT}/${relative}`,
      root: "r-relay",
      relative,
      kind: file.kind,
      ...(own.added + own.removed > 0 && { own }),
      ...(maybe.added + maybe.removed > 0 && { maybe }),
      before: file.kind === "create" ? null : ref(String.fromCharCode(97 + index)),
      after: ref(String.fromCharCode(101 + index)),
      entries: { first: 400 + index, last: 420 + index },
    }
  })
  const sum = (pick: (file: TurnChangedFile) => { added: number; removed: number } | null | undefined) => {
    const picked = files.map(pick).filter((lines) => lines)
    return { files: picked.length, added: picked.reduce((total, lines) => total + (lines?.added ?? 0), 0), removed: picked.reduce((total, lines) => total + (lines?.removed ?? 0), 0) }
  }
  return { version: TURN_CHANGES_VERSION, state: "settled", thread: "fixture-thread", turn: turns[1]!.id, own: sum((file) => file.own), maybe: sum((file) => file.maybe), others: { files: 2, added: 2, removed: 2 }, files, more: 0, journal: "5f1e2d3c-4b5a-4968-8776-655443322110", through: 430, at: Date.now() - 600_000 }
})()

/** Turns 1 and 3 changed a file each. */
const small = (turn: string, relative: string, added: number, removed: number): TurnChanges => ({
  ...record,
  turn,
  own: { files: 1, added, removed },
  maybe: { files: 0, added: 0, removed: 0 },
  files: [{ path: `${ROOT}/${relative}`, root: "r-relay", relative, kind: removed ? "modify" : "create", own: { added, removed }, before: removed ? ref("1") : null, after: ref("2"), entries: { first: 300, last: 310 } }],
})
const records = [small(turns[0]!.id, "src/net/fetch-retry.ts", 19, 0), record, small(turns[2]!.id, "src/net/fetch-retry.test.ts", 64, 0)]

const gitFile = (file: TurnChangedFile): GitFile => {
  const lines = [file.own, file.maybe].filter((counted) => counted)
  return { path: file.relative, status: file.kind === "create" ? "added" : "modified", staged: false, insertions: lines.reduce((sum, counted) => sum + (counted?.added ?? 0), 0), deletions: lines.reduce((sum, counted) => sum + (counted?.removed ?? 0), 0), binary: false }
}

const preview: TurnUndoPreview = {
  scope: { kind: "turn", requestId: turns[1]!.id },
  checkout: ROOT,
  undo: [
    { path: "src/net/backoff.ts", kind: "remove", removes: 11, restores: 0, kept: { person: 0, other: 0, thread: 0, maybe: 0, unknown: 0 } },
    { path: "src/net/fetch-retry.ts", kind: "lines", removes: 17, restores: 12, kept: { person: 1, other: 1, thread: 0, maybe: 0, unknown: 0 } },
  ],
  kept: [
    { path: "docs/networking.md", kept: { person: 0, other: 0, thread: 0, maybe: 3, unknown: 0 }, why: "maybe" },
    { path: "src/net/fetch-retry.ts", kept: { person: 1, other: 1, thread: 0, maybe: 0, unknown: 0 } },
  ],
  left: [{ path: "src/net/client.ts", lines: { start: 4, length: 2 }, reason: "edited-since", by: ["person"] }],
  token: "fixture",
}

const status: GitStatus = {
  cwd: ROOT, root: ROOT, branch: "retry-backoff", head: "a".repeat(40), upstream: "origin/retry-backoff", ahead: 2, behind: 0,
  files: [...FILES].map(([path, file]) => ({ path, status: file.kind === "create" ? "untracked" : "modified", staged: false, insertions: 4, deletions: 2, binary: false })),
}

const bridge = window.mako!
window.mako = {
  ...bridge,
  gitStatus: async () => status,
  gitLog: async () => [],
  liveTurnChanges: async (_id, requestId, workspace) => {
    const found = records.find((each) => each.turn === requestId)
    return { root: workspace ?? ROOT, files: (found?.files ?? []).map(gitFile) }
  },
  liveTurnDiff: async (_id, requestId, path, options) => {
    const file = FILES.get(path)
    const lines = requestId === record.turn && file ? file.lines : add("turn", "export {}")
    const old = file?.kind === "create" && requestId === record.turn ? null : options?.only ? onlyBefore(lines) : before(lines)
    const diff: GitDiff = { path, binary: false, oldFile: old === null ? null : { name: path, contents: old }, newFile: { name: path, contents: after(lines) } }
    return diff
  },
  liveTurnWriters: async (_id, requestId, path) => {
    const file = requestId === record.turn ? FILES.get(path) : undefined
    return file ? { path, runs: runsOf(file.lines), body: "checkpoints" } : null
  },
  liveTurnUndoPreview: async (_id, scope) => ({ ...preview, scope }),
  liveTurnUndo: async () => ({ files: 2, backup: "refs/mako/moves/4c1d9e2a-77b0-4f5e-9a51-0b8e3d2c6f14", left: preview.left }),
}

const snapshot: LiveSnapshot = {
  session: { id, harness: "claude", nativeId: "fixture", cwd: ROOT, title: "Retry failed requests", connection: "connected", status: "ready", modes: [], currentMode: null, configOptions: [] },
  revision: 1,
  createdAt: 1,
  base: null,
  permissions: [],
  requests: turns.map((turn, index) => ({ id: turn.id, text: turn.text, attachments: [], status: "completed", changes: records[index] })),
  blocks: turns.flatMap((turn) => [{ type: "user" as const, text: turn.text, requestId: turn.id }, { type: "text" as const, text: "Done." }]),
}

document.documentElement.classList.toggle("light", new URLSearchParams(location.search).get("theme") !== "dark")
prefsStore.set({ theme: new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light", changesLayout: "review", diffStyle: "unified" })
bindTheme()
threadsStore.set({ composerHarness: "claude", descriptors: fixtureHarnesses })
threadTitlesStore.set({ byThread: { [OTHER]: { title: "Move logging under telemetry", source: "user" } } })
store.set({ phase: "ready", meta: { ...META, cwd: ROOT }, git: status })
workspaceTransitionStore.set({ kind: "ready" })
acpStore.set({ activeKey: id })
mock.setLiveSnapshot(snapshot)
applyLiveSnapshot(snapshot)
reviewTurn(ROOT, { conversation: id, requestId: record.turn, prompt: turns[1]!.text })

export function Fixture() {
  const cwd = useSession((state) => state.meta?.cwd)
  return (
    <TooltipProvider>
      <WorkspaceFocusContext.Provider value={{ cwd, ready: true, identity: `fixture:${cwd}` }}>
        <main className="flex h-screen justify-center bg-shell text-foreground">
          <aside data-changes className="flex w-[760px] min-w-0 shrink-0 flex-col border-x border-hairline bg-surface"><ChangesPanel /></aside>
        </main>
      </WorkspaceFocusContext.Provider>
    </TooltipProvider>
  )
}

const node = document.getElementById("root")
if (node) createRoot(node).render(<Fixture />)
