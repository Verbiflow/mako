import assert from "node:assert/strict"
import { test } from "node:test"
import type { ListedSession, ReportedSession } from "@mako/protocol/thread-listing"
import { listedSummary } from "@mako/host/contracts/listed-conversations"
import type { LiveSummary } from "@mako/host/contracts/live-conversations"
import { nativeConversation, ownedSessions, type NativeRow, type ReportSources } from "@mako/host/conversations/session-report"
import { listedSummaries } from "../src/web-client/desk-listing"
import { canonicalThreadRefs, readsThreadRefs, selectAcpPresence, selectSessionOwners } from "../src/state/acp-presence"
import { acpStore } from "../src/state/acp-state"
import { hydrateLiveSummaries, listLive } from "../src/state/live-recovery"
import { groupThreadFolders, orderThreadFolders, workedFolderRanks } from "../src/lib/thread-folders"
import type { ThreadRef } from "../src/lib/types"

/**
 * The project order is the same on every device: a Mac's window and the web, given the same account list, put the
 * projects in the same order, by when the person last sent a message there from whichever device, never by what the
 * agents did since or what loaded first.
 */

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`
const STUDIO = uuid(900)
const LAPTOP = uuid(901)
const T = Date.parse("2026-10-30T09:00:00.000Z")
const minute = (n: number) => T + n * 60_000
const NOW = minute(100)

const summary = (id: string, cwd: string, createdAt: number, fields: Partial<LiveSummary> = {}): LiveSummary => ({
  session: { id, harness: "codex", cwd, status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  revision: 1,
  createdAt,
  ...fields,
})

/** A host's report of what it owns: its conversations, each in Session `sessions[id]` of Thread `threads[id]`, and its harnesses' sessions. */
function report(summaries: LiveSummary[], native: NativeRow[], placed: Record<string, { session: number; thread: number }>, moved: Record<string, number> = {}): ReportedSession[] {
  const sources: ReportSources = {
    summaries: () => summaries,
    native: () => native,
    activity: () => undefined,
    work: () => [],
    waitingOn: () => undefined,
    hidden: () => new Set(),
    lastMoved: (id) => moved[id],
    // SAFETY: test IDs in the Thread store's shapes, which brand plain UUIDs.
    placement: (id) => ({ thread: uuid(placed[id]!.thread), session: uuid(placed[id]!.session) }) as never,
    executions: () => new Map(),
    titles: (threads) => new Map(threads.map((thread) => [thread, { title: "", titleSource: "auto" }] as const)),
    now: () => NOW,
  }
  return ownedSessions(sources)
}

// This Mac (Studio): a Codex conversation in api, whose last message came from the phone a while ago; a conversation
// in web started later, which its agent has kept busy since without a word from the person; and a Claude session a
// terminal runs in docs, started early and writing ever since.
const apiFile = "/Users/ana/.codex/sessions/2026/10/30/rollout-api.jsonl"
const docsFile = "/Users/ana/.claude/projects/-Users-ana-docs/terminal-docs.jsonl"
const catalog: ThreadRef[] = [
  { harness: "codex", nativeId: "codex-api", path: apiFile, cwd: "/Users/ana/api", workspace: "/Users/ana/api", title: "Retry the webhooks", startedAt: new Date(minute(0)).toISOString(), updatedAt: new Date(minute(55)).toISOString(), threadId: uuid(101), sessionId: uuid(1) },
  { harness: "claude", nativeId: "terminal-docs", path: docsFile, cwd: "/Users/ana/docs", workspace: "/Users/ana/docs", title: "Rewrite the guide", startedAt: new Date(minute(20)).toISOString(), updatedAt: new Date(minute(95)).toISOString(), threadId: uuid(103), sessionId: uuid(3) },
]
const studioOwn = [
  summary("c-1", "/Users/ana/api", minute(0), { promptedAt: minute(50), threadPath: apiFile, nativeIds: [{ provider: "codex", nativeId: "codex-api" }] }),
  summary("c-2", "/Users/ana/web", minute(40)),
]
studioOwn[0]!.session.nativeId = "codex-api"
const studioRows = report(studioOwn, catalog, { "c-1": { session: 1, thread: 101 }, "c-2": { session: 2, thread: 102 } }, { "c-1": minute(55), "c-2": minute(90) })

// Another Mac (Laptop): a Session in web the person sent a message to most recently of all.
const laptopRows = report([summary("c-5", "/Users/ana/web", minute(10), { promptedAt: minute(70) })], [], { "c-5": { session: 5, thread: 105 } }, { "c-5": minute(72) })

// A cloud Thread's machine: a Session in infra, its machine's own report, by the same rule.
const cloudRows = report([summary("c-4", "/Users/ana/infra", minute(5), { promptedAt: minute(60) })], [], { "c-4": { session: 4, thread: 104 } }, { "c-4": minute(61) })

const listedAt = new Date(NOW).toISOString()
const account: ListedSession[] = [
  ...studioRows.map((row): ListedSession => ({ ...row, runsOn: { kind: "device", deviceId: STUDIO }, listedAt })),
  ...laptopRows.map((row): ListedSession => ({ ...row, runsOn: { kind: "device", deviceId: LAPTOP }, listedAt })),
  ...cloudRows.map((row): ListedSession => ({ ...row, runsOn: { kind: "cloud", threadId: "t-0123456789abcdef" }, listedAt })),
]
const devices = new Map([
  [STUDIO, { id: STUDIO, kind: "desktop", name: "Studio", platform: "macOS" }],
  [LAPTOP, { id: LAPTOP, kind: "desktop", name: "Laptop", platform: "macOS" }],
])

/** The rail's projects, in its order, from this window's catalog and conversations, as `AgentThreads` puts them. */
function railProjects(refs: ThreadRef[]): string[] {
  const state = acpStore.get()
  const owners = selectSessionOwners(state)
  const all = canonicalThreadRefs(refs, owners, [])
  const bound = readsThreadRefs(all)
  const live = selectAcpPresence(state).filter((presence) => !bound(presence))
  const folders = groupThreadFolders({ refs: all, live, pinnedThreads: [], pinnedFolders: [], sortBy: "recent" })
  return orderThreadFolders(folders, workedFolderRanks({ refs: all, live, owners }), "recent").flatMap((folder) => (folder.cwd ? [folder.cwd] : []))
}

function macWindow(otherRowsFirst = false): string[] {
  acpStore.set({ activeKey: null, conversations: {} })
  // The host lists other devices' Sessions by the same mapping the web uses (`CloudConversations`).
  const others = account.filter((row) => row.runsOn.kind !== "device" || row.runsOn.deviceId !== STUDIO)
    .map((row) => listedSummary(row, row.runsOn.kind === "cloud" ? "Cloud" : "Laptop", undefined))
  hydrateLiveSummaries(otherRowsFirst ? [...others, ...studioOwn] : [...studioOwn, ...others])
  return railProjects(catalog)
}

function web(): string[] {
  acpStore.set({ activeKey: null, conversations: {} })
  listLive(listedSummaries({ rows: account, devices, quiet: new Map(), waiting: new Map() }))
  return railProjects([])
}

test("a Mac's window and the web put the account's projects in the same order, by the person's last message from any device", () => {
  const studio = new Map(studioRows.map((row) => [row.conversation, row]))
  assert.equal(studioRows.length, 3, "one row per Session: the api conversation's, not its catalog row's too")
  assert.equal(studio.get("c-1")?.promptedAt, new Date(minute(50)).toISOString(), "the owner says when the person last wrote, the phone's message included")
  assert.equal(studio.get("c-2")?.promptedAt, undefined)
  assert.equal(studio.get(nativeConversation(uuid(3)))?.createdAt, new Date(minute(20)).toISOString(), "a terminal session starts when its catalog row says")
  const expected = ["/Users/ana/web", "/Users/ana/infra", "/Users/ana/api", "/Users/ana/docs"]
  const desk = web()
  assert.deepEqual(desk, expected, "web: the Laptop's message, the cloud's, the phone's, then the terminal's start; the agents' work since moves none")
  assert.deepEqual(macWindow(), desk, "the Mac's window, from its catalog and its own conversations, says the same")
  assert.deepEqual(macWindow(true), desk, "whatever the window heard first")
  const byActivity = [...account].sort((left, right) => right.activityAt.localeCompare(left.activityAt)).map((row) => row.folder)
  assert.notDeepEqual([...new Set(byActivity)], expected, "and that isn't the order the agents' activity would give")
})
