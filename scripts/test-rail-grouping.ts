import assert from "node:assert/strict"
import { test } from "node:test"
import type { LinkedCheckout } from "@mako/host/contracts/checkout-heads"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { threadList, withListedRef } from "@mako/host/contracts/thread-list"
import type { WorktreeSummary } from "@mako/host/contracts/thread-worktrees"
import { plainPath, projectFolder, worktreeAt as worktreeByPass, worktreeIn } from "@mako/host/contracts/worktree-paths"
import { workspaceName } from "../src/lib/format"
import { groupThreadFolders, threadFolderKey, type FolderMap, type ThreadFolder, type ThreadFolderActivity } from "../src/lib/thread-folders"
import type { ThreadRef } from "../src/lib/types"
import type { AcpPresence } from "../src/state/acp-presence"
import { chatFoldersStore, chatGroupOf } from "../src/state/chat-folders"
import { applyCheckoutHeads } from "../src/state/checkout-heads"
import { applyThreadRef, applyThreads, threadsStore } from "../src/state/threads"
import { applyWorktreeSummaries, refreshWorktreeSummaries, worktreeAt, worktreeSummariesStore, worktreesStore } from "../src/state/worktrees"

/**
 * The rail's grouping after it stopped passing over every worktree for every row: the folders are the ones the
 * passes gave, a changed row lands where sorting the list again put it, and what the rail hears in one event it
 * hears as one change. The functions it replaced are kept below, as they were, to be held against.
 */

// The grouping as it was: a folder key by two passes over the worktrees per row, and a pass over the conversations per
// folder. Its rule for a system's per-user temporary folders is left out: no row here is in one.
function normalizedPath(path: string | undefined): string {
  const normalized = (path ?? "").replaceAll("\\", "/").replace(/\/+$/, "")
  return /^[A-Za-z]:\//.test(normalized) ? normalized.toLowerCase() : normalized
}

function folderPathBefore(path: string | undefined, folderMap: FolderMap): string {
  const project = path ? folderMap(path) : undefined
  const normalized = normalizedPath(project ?? path)
  if (!normalized) return ""
  if (/^\/(?:private\/)?tmp(?:\/|$)/.test(normalized)) return ""
  return normalized
}

function folderKeyBefore(ref: Pick<ThreadRef, "cwd" | "workspace" | "worktrees">, folderMap: FolderMap): string {
  const folder = ref.workspace ?? ref.cwd
  return folderPathBefore(projectFolder(ref.worktrees, folder) ?? folder, folderMap)
}

const isHomePath = (path: string) => /^\/(?:Users|home)\/[^/]+$/.test(path)

function compareFolders(a: ThreadFolder, b: ThreadFolder, sortBy: "recent" | "created" | "name"): number {
  if (a.cwd === null || b.cwd === null) return a.cwd === null ? 1 : -1
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
  if (a.pinned && b.pinned) return a.pinRank - b.pinRank
  if (sortBy === "name") return a.name.localeCompare(b.name)
  return b.order.localeCompare(a.order)
}

interface Grouping {
  refs: ThreadRef[]
  live: AcpPresence[]
  currentCwd?: string
  pinnedThreads: string[]
  pinnedFolders: string[]
  priorities: Record<string, number>
  activity: Record<string, ThreadFolderActivity>
  sortBy: "recent" | "created" | "name"
  folderMap: FolderMap
}

function groupBefore({ refs, live, currentCwd, pinnedThreads, pinnedFolders, priorities, activity, sortBy, folderMap }: Grouping): ThreadFolder[] {
  const recency = (ref: ThreadRef): string => ref.updatedAt ?? ""
  const held = new Set(pinnedThreads)
  const byCwd = new Map<string, ThreadRef[]>()
  const allByCwd = new Map<string, ThreadRef[]>()
  for (const ref of refs) {
    const key = folderKeyBefore(ref, folderMap)
    const all = allByCwd.get(key)
    if (all) all.push(ref)
    else allByCwd.set(key, [ref])
    if (!byCwd.has(key)) byCwd.set(key, [])
    if (held.has(ref.path)) continue
    byCwd.get(key)?.push(ref)
  }
  for (const presence of live) {
    const key = folderKeyBefore(presence, folderMap)
    if (!byCwd.has(key)) byCwd.set(key, [])
  }
  const normalizedCurrent = folderPathBefore(currentCwd, folderMap)
  const currentKey =
    [...byCwd.keys()]
      .filter((key) => key && (key === normalizedCurrent || normalizedCurrent.startsWith(`${key}/`)))
      .sort((left, right) => right.length - left.length)[0] ?? normalizedCurrent
  if (currentKey && !byCwd.has(currentKey)) byCwd.set(currentKey, [])
  const byOrder = (a: ThreadRef, b: ThreadRef): number => {
    if (sortBy === "name") return (a.title ?? "").localeCompare(b.title ?? "")
    if (sortBy === "created") return (b.startedAt ?? "").localeCompare(a.startedAt ?? "")
    return recency(b).localeCompare(recency(a))
  }
  const normalizedPinnedFolders = pinnedFolders.map((path) => folderPathBefore(path, folderMap))
  const pinned = new Set(normalizedPinnedFolders)
  const result: ThreadFolder[] = [...byCwd.entries()].map(([key, entries]) => {
    entries.sort(byOrder)
    const allEntries = allByCwd.get(key) ?? entries
    const present = live.filter((presence) => folderKeyBefore(presence, folderMap) === key)
    const liveLatest = present.reduce((latest, presence) => Math.max(latest, presence.movedAt ?? presence.createdAt), 0)
    const latest = allEntries.reduce((top, ref) => ((ref.updatedAt ?? "") > top ? ref.updatedAt! : top), liveLatest ? new Date(liveLatest).toISOString() : "")
    const order =
      sortBy === "created"
        ? allEntries.reduce((top, ref) => ((ref.startedAt ?? "") > top ? ref.startedAt! : top), "")
        : allEntries.reduce((top, ref) => (recency(ref) > top ? recency(ref) : top), liveLatest ? new Date(liveLatest).toISOString() : "")
    let running = present.filter((presence) => presence.status === "running" || presence.status === "starting").length
    let needsInput = present.filter((presence) => presence.status === "needs-permission").length
    let failed = present.filter((presence) => presence.status === "failed").length
    let priority = needsInput ? 5 : failed ? 4 : running ? 2 : 0
    let unread = 0
    let active = 0
    for (const ref of allEntries) {
      priority = Math.max(priority, priorities[ref.path] ?? 0)
      const state = activity[ref.path]
      if (state?.running) running += 1
      if (state?.needsInput) needsInput += 1
      if (state?.failed) failed += 1
      if (state?.unread) unread += 1
      if (state?.active) active += 1
    }
    return {
      key: key || "~",
      name: key ? (isHomePath(key) ? "Home" : workspaceName(key)) : "Other sessions",
      cwd: key || null,
      refs: entries,
      current: Boolean(currentKey) && key === currentKey,
      pinned: Boolean(key) && (pinned.has(key) || allEntries.some((ref) => [ref.cwd, ref.workspace].some((path) => Boolean(path) && pinned.has(folderPathBefore(path, folderMap))))),
      pinRank: -1,
      latest,
      order,
      priority,
      running,
      needsInput,
      failed,
      unread,
      active,
    }
  })
  const pinIndex = (folder: ThreadFolder) => {
    const direct = folder.cwd ? normalizedPinnedFolders.indexOf(folder.cwd) : -1
    if (direct >= 0) return direct
    const entries = allByCwd.get(folder.cwd ?? "") ?? folder.refs
    return normalizedPinnedFolders.findIndex((path) => entries.some((ref) => [ref.cwd, ref.workspace].some((candidate) => folderPathBefore(candidate, folderMap) === path)))
  }
  for (const folder of result) if (folder.pinned) folder.pinRank = pinIndex(folder)
  result.sort((a, b) => compareFolders(a, b, sortBy))
  return result
}

/** The folder map as the worktrees store built it: a pass over each list per path. */
function folderMapBefore(): FolderMap {
  const { worktrees, outside, mirrors } = worktreesStore.get()
  const byPath = new Map<string, LinkedCheckout>(mirrors.map((mirror) => [plainPath(mirror.path), mirror]))
  const chats = chatFoldersStore.get()
  return (path) => {
    const found = worktreeByPass(outside, path)
    if (projectFolder(worktrees, path) !== undefined) return projectFolder(worktrees, path)
    if (found) return `${found.worktree.repoRoot}${found.inside}`
    const plain = plainPath(path)
    for (let folder = plain; folder; folder = folder.slice(0, Math.max(0, folder.lastIndexOf("/")))) {
      const mirror = byPath.get(folder)
      if (mirror) return `${mirror.repoRoot}${plain.slice(folder.length)}`
    }
    return chatGroupOf(path, chats)
  }
}

// A window's places: a worktree Mako made of one repository, a Thread's checkout of a project folder holding two (a
// worktree of each inside the folder mirroring it), worktrees made outside Mako (one nested inside its own project),
// and a checkout that was removed, known from its sessions alone.
const home = "/Users/you"
const app = `${home}/app`
const shop = `${home}/shop`
const suite = `${home}/suite`
const appTree = `${home}/.mako/worktrees/app-1/fix-login`
const suiteCheckout = `${home}/.mako/worktrees/suite-1/rename`
const goneCheckout = `${home}/.mako/worktrees/suite-0/old`
const claudeTree = { path: `${shop}/.claude/worktrees/fix-cart`, repoRoot: shop }
const codexTree = { path: `${home}/.codex/worktrees/77aa/shop`, repoRoot: shop }
const base = "0".repeat(40)
const made = [
  { thread: ThreadIdSchema.parse("00000000-0000-4000-8000-000000000001"), path: appTree, repoRoot: app, project: app, branch: "mako/fix-login", base, createdAt: 0 },
  ...["api", "web"].map((name) => ({ thread: ThreadIdSchema.parse("00000000-0000-4000-8000-000000000003"), path: `${suiteCheckout}/${name}`, repoRoot: `${suite}/${name}`, project: suite, branch: "mako/rename", base, createdAt: 0 })),
]

const at = (minute: number) => new Date(Date.UTC(2026, 8, 28, 9, minute)).toISOString()
const row = (id: string, minute: number, cwd: string | undefined, fields: Partial<ThreadRef> = {}): ThreadRef => ({ harness: "codex", nativeId: id, path: `/p/${id}.jsonl`, title: `Thread ${id}`, cwd, startedAt: at(minute - 5), updatedAt: at(minute), ...fields })
const refs: ThreadRef[] = [
  row("app", 50, app),
  row("app-web", 49, `${app}/web`),
  row("app-web-deep", 48, `${app}/web/src`, { workspace: `${app}/web` }),
  row("in-made", 47, `${appTree}/web`),
  row("in-made-spelled", 46, `/private${appTree}`),
  row("suite-member", 45, `${suiteCheckout}/api/src`),
  row("suite-checkout", 44, suiteCheckout),
  row("suite-notes", 43, `${suiteCheckout}/notes`),
  row("claude-tree", 42, claudeTree.path, { worktrees: [claudeTree] }),
  row("codex-tree", 41, `${codexTree.path}/api`, { worktrees: [codexTree] }),
  row("moved-in", 40, shop, { currentCwd: claudeTree.path, worktrees: [claudeTree] }),
  row("gone", 39, `${goneCheckout}/api`, { worktrees: [{ path: goneCheckout, repoRoot: suite, mirrors: true }] }),
  row("shop", 38, shop),
  row("same-time", 38, shop),
  row("home", 37, home),
  row("scratch", 36, "/private/tmp/scratch-run"),
  row("nowhere", 35, undefined),
  row("pinned-thread", 34, `${shop}/api`),
]
const presence = (key: string, cwd: string, status: AcpPresence["status"], minute: number, fields: Partial<AcpPresence> = {}): AcpPresence => ({ key, harness: "claude", cwd, status, createdAt: Date.parse(at(minute)), ...fields })
const live: AcpPresence[] = [
  presence("live-made", `${appTree}/web`, "running", 20),
  presence("live-outside", codexTree.path, "needs-permission", 21),
  presence("live-suite", `${suiteCheckout}/web`, "failed", 22, { movedAt: Date.parse(at(55)) }),
  presence("live-elsewhere", "/srv/work/app", "ready", 23, { workspace: app }),
  presence("live-scratch", "/tmp/elsewhere", "ready", 24),
  presence("live-own", `${home}/notes`, "starting", 25),
]

threadsStore.set({ threads: refs })
worktreesStore.set({ ...worktreesStore.get(), worktrees: made })
// A head read is what rebuilds the folder map over the worktrees now listed.
applyCheckoutHeads({ [claudeTree.path]: { kind: "branch", name: "worktree-fix-cart", linked: claudeTree } })

test("an indexed worktree lookup answers as a pass over the list did", () => {
  const { worktrees, outside } = worktreesStore.get()
  assert.equal(worktrees.length, 3)
  assert.deepEqual(outside.map((entry) => entry.path), [claudeTree.path, codexTree.path])
  const overlapping = [{ path: "/a/b", repoRoot: "/r1" }, { path: "/a", repoRoot: "/r2" }, { path: "/a/b/c", repoRoot: "/r3" }, { path: "/a", repoRoot: "/r4" }, { path: "/private/tmp/t", repoRoot: "/r5" }]
  const paths = [
    ...refs.flatMap((ref) => [ref.cwd, ref.currentCwd, ref.workspace]), ...live.map((each) => each.cwd),
    appTree, `${appTree}-other`, `${appTree}/`, `/private${appTree}/web`, suiteCheckout, `${suiteCheckout}/api`, `${suiteCheckout}/apiary`, `${suiteCheckout}/notes/x`,
    claudeTree.path, `${claudeTree.path}/api/src`, codexTree.path, `${home}/.codex/worktrees`, home, "/", "", undefined, "relative/path", "/a", "/a/b", "/a/b/c/d", "/a/bc", "/a//b", "/tmp/t/x", "/private/tmp/t",
  ]
  const lists: (readonly { path: string; repoRoot?: string; project?: string }[])[] = [worktrees, outside, overlapping, []]
  for (const list of lists)
    for (const path of paths) assert.deepEqual(worktreeIn(list, path), worktreeByPass(list, path), `the worktree at ${path}`)
  assert.equal(worktreeAt(worktrees, `${suiteCheckout}/notes`)?.worktree.repoRoot, `${suite}/api`, "a path in the checkout and outside its repositories finds its first worktree")
  assert.equal(worktreeAt(overlapping, "/a/b/c")?.worktree.repoRoot, "/r1", "of several that hold a path, the first listed")
  assert.equal(worktreeIn(undefined, appTree), undefined)
})

test("every row files under the folder it did, and the folders come out as they did", () => {
  const before = folderMapBefore()
  const { folderMap } = worktreesStore.get()
  for (const path of [...refs.flatMap((ref) => [ref.cwd, ref.workspace, ref.currentCwd]), ...live.map((each) => each.cwd), goneCheckout, `${goneCheckout}-other`, `/private${suiteCheckout}/web`])
    if (path !== undefined) assert.equal(folderMap(path), before(path), `the project of ${path}`)
  for (const each of [...refs, ...live]) assert.equal(threadFolderKey(each, folderMap), folderKeyBefore(each, before), `the folder of ${"path" in each ? each.path : each.key}`)
  assert.equal(threadFolderKey(refs[3]!, folderMap), `${app}/web`, "a folder in a worktree files under the project's same folder")
  assert.equal(threadFolderKey(refs[11]!, folderMap), `${suite}/api`, "a removed checkout's session files under its project")

  const priorities = { "/p/app.jsonl": 2, "/p/shop.jsonl": 5, "/p/gone.jsonl": 3 }
  const activity = { "/p/app.jsonl": { running: true }, "/p/shop.jsonl": { needsInput: true }, "/p/gone.jsonl": { unread: true }, "/p/home.jsonl": { active: true }, "/p/scratch.jsonl": { failed: true } } satisfies Record<string, ThreadFolderActivity>
  const pinnings = [
    { pinnedThreads: [], pinnedFolders: [] },
    // A pinned project, one pinned by a worktree's folder, a nested folder, and one no row is in.
    { pinnedThreads: ["/p/pinned-thread.jsonl", "/p/app-web.jsonl"], pinnedFolders: [shop, `${appTree}/web`, `${suiteCheckout}/api`, `${home}/empty`] },
    { pinnedThreads: ["/p/shop.jsonl", "/p/same-time.jsonl"], pinnedFolders: [`${app}/web`, codexTree.path] },
  ]
  let compared = 0
  for (const sortBy of ["recent", "created", "name"] as const)
    for (const currentCwd of [undefined, `${app}/web/src/deep`, `${appTree}/web`, `${suiteCheckout}/notes`, `${home}/elsewhere`])
      for (const pinning of pinnings) {
        const input = { refs, live, currentCwd, priorities, activity, sortBy, ...pinning }
        const now = groupThreadFolders({ ...input, folderMap })
        assert.deepEqual(now, groupBefore({ ...input, folderMap: before }), `sorted by ${sortBy}, in ${currentCwd}, with ${pinning.pinnedFolders.length} pinned`)
        assert.deepEqual(groupThreadFolders({ ...input, folderMap }), now, "and the same again, from what it kept of the first time")
        compared += 1
      }
  assert.equal(compared, 45)
  const folders = groupThreadFolders({ refs, live, pinnedThreads: [], pinnedFolders: [], sortBy: "recent", folderMap })
  assert.deepEqual(folders.map((folder) => folder.key).sort(), [app, `${app}/web`, home, `${home}/notes`, shop, `${shop}/api`, suite, `${suite}/api`, `${suite}/api/src`, `${suite}/notes`, `${suite}/web`, "~"].sort())
  assert.deepEqual(folders.find((folder) => folder.key === `${suite}/web`), { key: `${suite}/web`, name: "web", cwd: `${suite}/web`, refs: [], current: false, pinned: false, pinRank: -1, latest: at(55), order: at(55), priority: 4, running: 0, needsInput: 0, failed: 1, unread: 0, active: 0 })
})

test("a changed row lands where sorting the list again put it", () => {
  const sorted = (list: ThreadRef[]) => [...list].sort((left, right) => (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""))
  // Times that tie, as a burst of writes in one second does, and rows with none.
  const times = [at(10), at(10), at(10), at(11), at(12), at(12), undefined, undefined, at(13), at(9)]
  const list = sorted(times.map((updatedAt, index): ThreadRef => ({ harness: "codex", nativeId: `r-${index}`, path: `/p/r-${index}.jsonl`, updatedAt })))
  let placed = 0
  for (const [index, held] of list.entries())
    for (const updatedAt of [at(8), at(9), at(10), at(11), at(12), at(13), at(14), undefined, held.updatedAt]) {
      const changed = { ...held, updatedAt, bytes: 1 }
      assert.deepEqual(withListedRef(list, changed, index), sorted(list.map((ref, at) => (at === index ? changed : ref))), `row ${index} moved to ${updatedAt}`)
      const added = { ...held, nativeId: "new", path: "/p/new.jsonl", updatedAt }
      assert.deepEqual(withListedRef(list, added, -1), sorted([...list, added]), `a new row at ${updatedAt}`)
      placed += 2
    }
  assert.equal(placed, list.length * 18)
  assert.deepEqual(withListedRef([], list[0]!, -1), [list[0]])
})

test("a row seen moving is one change to the list's store", () => {
  applyThreads(threadList(refs))
  const quiet = refs.find((ref) => ref.nativeId === "shop")!
  assert.equal(threadsStore.get().observed[quiet.path], undefined)
  let said = 0
  const stop = threadsStore.subscribe(() => {
    said += 1
  })
  const moved = { ...quiet, updatedAt: at(59), bytes: 10 }
  applyThreadRef(moved)
  stop()
  assert.equal(said, 1, "the list and the row's having moved are said together")
  const state = threadsStore.get()
  assert.equal(state.observed[quiet.path], true)
  assert.deepEqual(state.threads.map((ref) => ref.path), threadList(refs.map((ref) => (ref.path === quiet.path ? moved : ref))).map((ref) => ref.path), "and the list is the one a reload gives")
  assert.equal(state.threads[0]?.path, quiet.path)
  // Its harness saying whether it's at work is the better word: the mark its file moving left goes, in the same change.
  let saidAgain = 0
  const stopAgain = threadsStore.subscribe(() => {
    saidAgain += 1
  })
  applyThreadRef({ ...moved, active: false })
  stopAgain()
  assert.equal(saidAgain, 1)
  assert.equal(threadsStore.get().observed[quiet.path], undefined)
})

test("a summary that says what it did stays the object it was", () => {
  const summary = (path: string, changes: number): WorktreeSummary => ({ path, into: "main", ahead: 1, changes, landing: { kind: "open", into: "main", commits: 1 }, pull: null, behind: { from: "origin/main", commits: 2 } })
  applyWorktreeSummaries([summary(appTree, 0), summary(`${suiteCheckout}/api`, 3), summary(`${suiteCheckout}/web`, 0)])
  const before = worktreeSummariesStore.get().byPath
  let said = 0
  const stop = worktreeSummariesStore.subscribe(() => {
    said += 1
  })
  applyWorktreeSummaries([summary(appTree, 0), summary(`${suiteCheckout}/api`, 3), summary(`${suiteCheckout}/web`, 0)])
  assert.equal(said, 0, "the same word again changes nothing")
  assert.equal(worktreeSummariesStore.get().byPath, before)
  applyWorktreeSummaries([summary(appTree, 0), summary(`${suiteCheckout}/api`, 4), summary(`${suiteCheckout}/web`, 0)])
  const after = worktreeSummariesStore.get().byPath
  assert.equal(said, 1)
  assert.equal(after[appTree], before[appTree], "a worktree that didn't change keeps its summary")
  assert.equal(after[`${suiteCheckout}/web`], before[`${suiteCheckout}/web`])
  assert.equal(after[`${suiteCheckout}/api`]?.changes, 4)
  applyWorktreeSummaries([summary(appTree, 0)])
  stop()
  assert.equal(said, 2, "a worktree gone is a change")
  assert.deepEqual(Object.keys(worktreeSummariesStore.get().byPath), [appTree])
})

test("callers asking for the summaries at once share one ask out and one behind it", async () => {
  const answers: ((summaries: WorktreeSummary[]) => void)[] = []
  Object.assign(globalThis, { window: { mako: { worktreeSummaries: () => new Promise<WorktreeSummary[]>((resolve) => answers.push(resolve)) } } })
  try {
    const first = refreshWorktreeSummaries()
    const behind = [refreshWorktreeSummaries(), refreshWorktreeSummaries(), refreshWorktreeSummaries()]
    assert.equal(answers.length, 1, "one ask is out, however many asked")
    assert.ok(behind.every((each) => each === behind[0]) && behind[0] !== first, "the rest wait for the next one together")
    answers[0]!([])
    await first
    await Promise.resolve()
    assert.equal(answers.length, 2, "which starts when the first lands, so it's no older than their asking")
    answers[1]!([])
    await Promise.all(behind)
    assert.equal(answers.length, 2)
    void refreshWorktreeSummaries()
    assert.equal(answers.length, 3, "and with nothing out, the next caller asks at once")
    answers[2]!([])
  } finally {
    Reflect.deleteProperty(globalThis, "window")
  }
})
