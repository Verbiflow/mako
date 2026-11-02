import type { StorageCollection, StoragePart, StorageReport } from "@mako/host/contracts/storage"

const GB = 1024 ** 3
const MB = 1024 ** 2

/** Mako's folders as measured on a long-used Mac on 2026-11-01, before its Cursor checkpoints were ever collected. */
function parts(cursorBytes: number): StoragePart[] {
  const user = "/Users/you/.mako"
  const data = "/Users/you/Library/Application Support/mako"
  return [
    { id: "cursor-sdk", label: "Cursor agents", detail: "Each Cursor agent's conversation as Cursor's SDK keeps it. The SDK saves the whole conversation again after every step and deletes none of those copies; Mako removes the ones nothing reads once an agent has been idle for half an hour.", path: `${user}/cursor-sdk`, bytes: cursorBytes, collected: true },
    { id: "records", label: "Session records", detail: "Every version of every session, compressed and shared between versions, so a conversation reads as it was at any turn and syncs. A pack is rewritten once half of it is no longer used.", path: `${user}/records`, bytes: 23.48 * GB, collected: false },
    { id: "worktrees", label: "Thread worktrees", detail: "Checkouts of Threads on their own branch. Settings › Worktrees removes them.", path: `${user}/worktrees`, bytes: 7.92 * GB, collected: false },
    { id: "workspace-snapshots", label: "Rewind snapshots", detail: "Files as they were before each turn, for Rewind.", path: `${data}/workspace-snapshots`, bytes: 3.1 * GB, collected: false },
    { id: "conversations", label: "Conversation journals", detail: "Each conversation's journal; a closed one is compacted.", path: `${data}/conversations`, bytes: 2.0 * GB, collected: false },
    { id: "updates", label: "Update checkout", detail: "The source and build Mako updates itself from.", path: `${data}/updates`, bytes: 1.96 * GB, collected: false },
    { id: "archive", label: "Archived Threads", detail: "What an archived Thread kept, to bring it back.", path: `${user}/archive`, bytes: 1.17 * GB, collected: false },
    { id: "browser-host-releases", label: "browser-host-releases", detail: "", path: `${user}/browser-host-releases`, bytes: 760 * MB, collected: false },
    { id: "catalogs", label: "Catalogs", detail: "Each harness's list of sessions, made again when needed.", path: `${user}/catalogs`, bytes: 700 * MB, collected: false },
    { id: "rest", label: "Everything else", detail: "Folders and files under 50 MB each.", path: "", bytes: 2.9 * GB, collected: false },
  ]
}

/** Settings › Storage on the mock desk; `?mock&storage=low` draws a disk under the warning line. */
export function mockStorage() {
  const low = new URLSearchParams(globalThis.location?.search).get("storage") === "low"
  const totalBytes = 926 * GB
  let freeBytes = low ? 6.4 * GB : 78 * GB
  let cursorBytes = 30.85 * GB
  const collections: StorageCollection[] = []
  const report = (): StorageReport => ({
    at: new Date(Date.now() - 2 * 60_000).toISOString(),
    disk: { freeBytes, totalBytes },
    lowBytes: 10 * GB,
    parts: parts(cursorBytes).sort((a, b) => (a.id === "rest" ? 1 : b.id === "rest" ? -1 : b.bytes - a.bytes)),
    collections,
    measuring: false,
    collecting: false,
  })
  return {
    storage: async () => report(),
    freeStorage: async () => {
      const freed = 18.86 * GB
      cursorBytes -= freed
      freeBytes += freed
      collections.unshift({ part: "cursor-sdk", at: new Date().toISOString(), trigger: "person", freedBytes: freed, collected: 68, skipped: 1, ms: 228_000 })
      return report()
    },
  }
}
