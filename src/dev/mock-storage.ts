import type { ReclaimClass, ReclaimItem, ReclaimOutcome, ReclaimStore, StorageBudgetSettings, StorageCollection, StoragePart, StorageReport } from "@mako/host/contracts/storage"
import type { SnapshotBudgetSettings } from "@mako/host/contracts/snapshot-budget"
import type { ThreadScratchSettings } from "@mako/host/contracts/thread-scratch"
import type { WorktreeRetentionSettings } from "@mako/host/contracts/thread-worktrees"

const GB = 1024 ** 3
const MB = 1024 ** 2

/** Mako's folders as measured on a long-used Mac on 2026-11-01, before its Cursor checkpoints were ever collected. */
function parts(cursorBytes: number): StoragePart[] {
  const user = "/Users/you/.mako"
  const data = "/Users/you/Library/Application Support/mako"
  return [
    { id: "cursor-sdk", label: "Cursor agents", detail: "Each Cursor agent's conversation as Cursor's SDK keeps it. The SDK saves the whole conversation again after every step and deletes none of those copies; Mako removes the ones nothing reads once an agent has been idle for half an hour.", path: `${user}/cursor-sdk`, bytes: cursorBytes, collected: true },
    { id: "records", label: "Session records", detail: "Every version of every session, compressed and shared between versions, so a conversation reads as it was at any turn and syncs. After each sync pass, what a deleted session alone used is removed, and a pack is rewritten once a fifth of it is no longer used.", path: `${user}/records`, bytes: 23.48 * GB, collected: true },
    { id: "worktrees", label: "Thread worktrees", detail: "Checkouts of Threads on their own branch. Settings › Worktrees removes them.", path: `${user}/worktrees`, bytes: 7.92 * GB, collected: false },
    { id: "workspace-snapshots", label: "Rewind snapshots", detail: "Files as they were before each turn, for Rewind.", path: `${data}/workspace-snapshots`, bytes: 3.1 * GB, collected: false },
    { id: "conversations", label: "Conversation journals", detail: "Each conversation's journal; a closed one is compacted.", path: `${data}/conversations`, bytes: 2.0 * GB, collected: false },
    { id: "updates", label: "Update checkout", detail: "The source and build Mako updates itself from.", path: `${data}/updates`, bytes: 1.96 * GB, collected: false },
    { id: "archive", label: "Archived Threads", detail: "What an archived Thread kept, to bring it back.", path: `${user}/archive`, bytes: 1.17 * GB, collected: false },
    { id: "browser-host-releases", label: "browser-host-releases", detail: "", path: `${user}/browser-host-releases`, bytes: 760 * MB, collected: false },
    { id: "catalogs", label: "Catalogs", detail: "Each harness's list of sessions, made again when needed.", path: `${user}/catalogs`, bytes: 700 * MB, collected: false },
    { id: "rest", label: "Everything else", detail: "Folders and files under 50 MB each. Copies of a file a process stopped before saving are removed.", path: "", bytes: 2.9 * GB, collected: true },
  ]
}

const HOUR = 3_600_000
const USER_ROOT = "/Users/you/.mako"
type Row = [ReclaimStore, string, string, string | undefined, number, number, ReclaimClass, string]

/** What a Mac full of Fins' leftovers held on 2026-11-19, by store and class, under made-up Thread names. */
const ROWS: Row[] = [
  ["app-data", "thread-data/50b78ec0", "phone-open-2", "makomono", 59.1, 30, "approve", "The Fin finished; an Apex above it is still open."],
  ["app-data", "thread-data/folder-f6c41fc142b185e0/pool", "pool, in makomono", "makomono", 12.4, 360, "approve", "A folder's app data, shared by every Thread working there."],
  ["thread-data", "thread-data/owned/eef68aff/data", "frontier-mobile-app", "frontier", 11.9, 50, "approve", "Not archived."],
  ["app-data", "thread-data/c8dd67e9", "queue-rules", "makomono", 7.7, 40, "now", "The Fin finished and has been quiet for 3 days."],
  ["app-data", "thread-data/7dce0e9a", "capy-ux", "makomono", 7.6, 90, "now", "The Thread is archived."],
  ["app-data", "thread-data/folder-f6c41fc142b185e0/orchestration", "orchestration, in makomono", "makomono", 7.0, 300, "approve", "A folder's app data, shared by every Thread working there."],
  ["scratch", "thread-data/4675ffa3/scratch", "send-modes", "makomono", 5.3, 80, "now", "The Fin finished."],
  ["worktrees", "worktrees/flage-0562cfef/wed-28-oct-2026", "Wed 28 Oct", "flage", 4.8, 500, "approve", "Clean, pushed and quiet; its Thread isn't archived."],
  ["worktrees", "worktrees/makomono-f6c41fc1/host-loop-holds", "loop-holds", "makomono", 4.5, 45, "now", "Clean, pushed and quiet; its Thread finished or is archived, and a message makes it again."],
  ["worktrees", "worktrees/makomono-f6c41fc1/rail-fast-load", "rail-order-2", "makomono", 4.1, 60, "now", "Clean, pushed and quiet; its Thread finished or is archived, and a message makes it again."],
  ["snapshots", "Library/workspace-snapshots", "Rewind checkpoints in mako-backend", "mako-backend", 6.2, 200, "now", "Settled turns past the rewind budget, oldest first."],
  ["snapshots", "Library/workspace-snapshots", "Rewind checkpoints in makomono", "makomono", 3.4, 30, "approve", "Settled turns; Rewind no longer reaches them once they go."],
  ["worktrees", "worktrees/makomono-f6c41fc1/mako-fin-move", "fin-move", "makomono", 3.0, 20, "keep", "Its current HEAD is not reachable from a fetched remote ref."],
  ["worktrees", "worktrees/makomono-f6c41fc1/web-fast-load", "web-fast-load", "makomono", 2.9, 3, "keep", "The checkout has uncommitted changes."],
  ["app-data", "thread-data/folder-f6c41fc142b185e0/be-deploy", "be-deploy, in makomono", "makomono", 2.0, 1, "keep", "Written in the last two days."],
  ["scratch", "thread-data/9a1c0d22/scratch", "storage-settings", "makomono", 1.2, 0.2, "keep", "A provider, terminal or process has this scratch open."],
]

function planItems(): ReclaimItem[] {
  return ROWS.map(([store, path, label, project, gb, hours, kind, reason], index) => ({
    id: `${store}:${USER_ROOT}/${path}:${index}`, store, path: `${USER_ROOT}/${path}`, label, ...project && { project },
    ...store !== "snapshots" && !path.includes("folder-") && { thread: `thread-${label}` },
    bytes: gb * GB, usedAt: Date.now() - hours * HOUR, class: kind, reason,
  }))
}

/** Settings › Storage on the mock desk; `?mock&storage=low` draws a disk under the warning line. */
export function mockStorage() {
  const low = new URLSearchParams(globalThis.location?.search).get("storage") === "low"
  const totalBytes = 926 * GB
  let freeBytes = low ? 6.4 * GB : 78 * GB
  let cursorBytes = 30.85 * GB
  const collections: StorageCollection[] = [
    { part: "records", at: new Date(Date.now() - 40 * 60_000).toISOString(), trigger: "scheduled", freedBytes: 0.96 * GB, collected: 1, skipped: 0, ms: 118_000 },
  ]
  let items = planItems()
  let budget: StorageBudgetSettings = { autoFree: true }
  let scratch: ThreadScratchSettings = { mode: "remove", dataMode: "preview", idleDays: 3, kept: [] }
  let worktrees: WorktreeRetentionSettings = { mode: "preview", days: 7, kept: [] }
  let rewind: SnapshotBudgetSettings = { mode: "evict", maxBytes: 8 * GB }
  const reclaims: ReclaimOutcome[] = low ? [] : [{
    at: new Date(Date.now() - 2 * HOUR).toISOString(), trigger: "low disk", consent: "now", freedBytes: 14.2 * GB,
    removed: planItems().slice(3, 7), kept: [],
  }]
  const report = (): StorageReport => ({
    at: new Date(Date.now() - 2 * 60_000).toISOString(),
    disk: { freeBytes, totalBytes },
    lowBytes: 30 * GB,
    parts: parts(cursorBytes).sort((a, b) => (a.id === "rest" ? 1 : b.id === "rest" ? -1 : b.bytes - a.bytes)),
    collections,
    measuring: false,
    collecting: false,
    plan: { at: new Date(Date.now() - 60_000).toISOString(), items },
    planning: false,
    reclaiming: false,
    reclaims,
    budget,
  })
  return {
    storage: async () => report(),
    freeStorage: async () => {
      const freed = 18.86 * GB
      cursorBytes -= freed
      freeBytes += freed
      collections.unshift(
        { part: "cursor-sdk", at: new Date().toISOString(), trigger: "person", freedBytes: freed, collected: 68, skipped: 1, ms: 228_000 },
        { part: "rest", at: new Date().toISOString(), trigger: "person", freedBytes: 14 * MB, collected: 31, skipped: 0, ms: 12 },
      )
      return report()
    },
    planStorage: async () => report(),
    reclaimStorage: async (consent: "now" | "approve", ids: string[]) => {
      const wanted = new Set(ids)
      const removed = items.filter((item) => wanted.has(item.id) && (item.class === "now" || consent === "approve"))
      const freed = removed.reduce((sum, item) => sum + (item.bytes ?? 0), 0) * 0.6
      items = items.filter((item) => !removed.includes(item))
      freeBytes += freed
      reclaims.unshift({ at: new Date().toISOString(), trigger: "person", consent, freedBytes: freed, removed, kept: [] })
      return report()
    },
    setStorageBudget: async (next: StorageBudgetSettings) => {
      budget = next
      return report()
    },
    threadScratch: async () => ({ settings: scratch, at: Date.now(), everyMs: HOUR, entries: [] }),
    setThreadScratch: async (next: ThreadScratchSettings) => {
      scratch = next
      return { settings: scratch, at: Date.now(), everyMs: HOUR, entries: [] }
    },
    worktreeRetention: async () => ({ settings: worktrees, everyMs: HOUR, minimumPassMs: 600_000, repositoryFetches: 0, at: Date.now(), checkouts: [] }),
    setWorktreeRetention: async (next: WorktreeRetentionSettings) => {
      worktrees = next
      return { settings: worktrees, everyMs: HOUR, minimumPassMs: 600_000, repositoryFetches: 0, at: Date.now(), checkouts: [] }
    },
    snapshotBudget: async () => ({ settings: rewind, at: Date.now(), payloadBytes: 9.6 * GB, selectedBytes: 6.2 * GB, remainingBytes: 3.4 * GB, untrackedBytes: 0, inventoryKnown: true, entries: [] }),
    setSnapshotBudget: async (next: SnapshotBudgetSettings) => {
      rewind = next
      return { settings: rewind, at: Date.now(), payloadBytes: 9.6 * GB, selectedBytes: 0, remainingBytes: 9.6 * GB, untrackedBytes: 0, inventoryKnown: true, entries: [] }
    },
  }
}
