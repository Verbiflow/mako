import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { access, mkdir, mkdtemp, readdir, realpath, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { HostEvent } from "@mako/host/contracts/host-events-boot"
import { storageLowBytes, type ReclaimItem, type ReclaimStore } from "@mako/host/contracts/storage"
import { ThreadIdSchema, type ThreadId } from "@mako/host/contracts/thread-identity"
import type { ThreadWorktree } from "@mako/host/contracts/thread-worktrees"
import { MakoStorage, type StorageReclaimer } from "@mako/host/usage/storage"
import { AppDataRetention } from "@mako/host/workspaces/app-data-retention"
import { ThreadScratch } from "@mako/host/workspaces/thread-scratch"
import { WorktreeRetention } from "@mako/host/workspaces/worktree-retention"

/**
 * Retention per store and the disk budget (Settings › Storage): scratch goes by default once its Thread is archived, is
 * a Fin that finished, or finished and stayed quiet; old `thread-data/<app key>` folders go once their Thread is
 * archived; an archived Thread's worktree is retired like a finished Fin's. Whatever a running turn, a process or an
 * open file uses, whatever holds uncommitted or unpushed work, and whatever is kept stays, whoever asks. Under the low
 * line the expendable goes oldest first until the disk has room, and the person is told what went.
 */
const root = await realpath(await mkdtemp(join(tmpdir(), "mako-storage-reclaim-")))
after(() => rm(root, { recursive: true, force: true }))
const DAY = 86_400_000
const GB = 1024 ** 3
const exists = (path: string) => access(path).then(() => true, () => false)
const thread = () => ThreadIdSchema.parse(randomUUID())

test("scratch: removed by default once archived, a finished Fin's, or quiet; never while in use", async () => {
  const base = join(root, "scratch")
  let now = 10 * DAY
  const owners = new Map<ThreadId, { quietAt: number; finishedAt?: number } | undefined>()
  const archived = new Set<ThreadId>(), fins = new Set<ThreadId>()
  let open: string[] = [], users: string[] = []
  const scratch = new ThreadScratch({
    root: join(base, "thread-data"), registry: join(base, "owners"), settings: join(base, "settings.json"), now: () => now,
    owner: (id) => owners.get(id), archived: (id) => archived.has(id), fin: (id) => fins.has(id),
    using: async () => users, openFiles: async () => open, privateBytes: async () => null,
  })
  const settings = await scratch.settings()
  assert.deepEqual([settings.mode, settings.idleDays], ["remove", 3], "scratch goes by default, after three quiet days")

  const personal = thread(), fin = thread(), gone = thread(), running = thread(), busy = thread()
  for (const id of [personal, fin, gone, running, busy]) await writeFile(join(await scratch.ensure(id), "bench"), "x")
  // Every turn of a personal Thread "finishes": a day later it isn't scratch to remove by itself.
  owners.set(personal, { quietAt: now + 1, finishedAt: now + 1 })
  owners.set(fin, { quietAt: now + 1, finishedAt: now + 1 }); fins.add(fin)
  owners.set(gone, { quietAt: now + 1, finishedAt: now + 1 }); archived.add(gone)
  owners.set(running, undefined)
  owners.set(busy, { quietAt: now + 1, finishedAt: now + 1 }); archived.add(busy)
  open = [join(scratch.path(busy), "bench")]
  now += DAY

  const classes = Object.fromEntries((await scratch.items()).map((item) => [item.thread, item.class]))
  assert.deepEqual([classes[personal], classes[fin], classes[gone], classes[running], classes[busy]], ["approve", "now", "now", "keep", "keep"])

  await scratch.run()
  assert.equal(await exists(scratch.path(fin)), false, "a finished Fin's scratch went")
  assert.equal(await exists(scratch.path(gone)), false, "an archived Thread's scratch went")
  assert.equal(await exists(scratch.path(personal)), true, "a personal Thread's stays through its quiet days")
  assert.equal(await exists(scratch.path(running)), true, "a running turn's stays")
  assert.equal(await exists(scratch.path(busy)), true, "an open file's stays")

  const item = (id: ThreadId) => ({ id: `scratch:${scratch.path(id)}`, store: "scratch" as const, path: scratch.path(id), label: id, thread: id, bytes: 1, class: "approve" as const, reason: "" })
  assert.notEqual((await scratch.reclaim([item(personal)], "now")).get(item(personal).id), true, "Mako's own pass never takes what needs the person's OK")
  assert.equal((await scratch.reclaim([item(running), item(busy)], "approve")).get(item(running).id) === true, false, "the person's OK never takes a running turn's scratch")
  assert.equal(await exists(scratch.path(busy)), true, "nor one a process has open")
  assert.equal((await scratch.reclaim([item(personal)], "approve")).get(item(personal).id), true, "with the OK, a quiet personal Thread's goes")
  assert.equal(await exists(scratch.path(personal)), false)

  users = ["an open terminal"]; open = []
  const later = thread()
  await scratch.ensure(later)
  owners.set(later, { quietAt: now, finishedAt: now }); archived.add(later)
  now += 4 * DAY
  await scratch.run()
  assert.equal(await exists(scratch.path(later)), true, "a terminal in it keeps it, archived and quiet or not")
  scratch.close()
})

test("old app data: an archived Thread's goes, its registered scratch and anything in use stay", async () => {
  const data = join(root, "app-data")
  const archivedThread = thread(), openThread = thread(), finThread = thread(), fresh = thread(), runningApp = thread(), kept = thread()
  const folder = "folder-0123456789abcdef"
  const old = new Date(Date.now() - 10 * DAY)
  const make = async (path: string) => {
    await mkdir(path, { recursive: true })
    await writeFile(join(path, "payload"), "x".repeat(4096))
    await utimes(join(path, "payload"), old, old)
    await utimes(path, old, old)
  }
  for (const id of [archivedThread, openThread, finThread, fresh, runningApp, kept]) {
    await make(join(data, id, "t3bench"))
    await make(join(data, id, "scratch"))
  }
  await writeFile(join(data, fresh, "t3bench", "new"), "written today")
  await writeFile(join(data, kept, ".keep"), "")
  await make(join(data, folder, "pool"))
  let open: string[] = [join(data, openThread, "t3bench", "payload")]
  const retention = new AppDataRetention({
    root: data, title: (id) => `Thread ${id.slice(0, 4)}`, known: () => true,
    owner: (id) => ({ quietAt: Date.now() - 10 * DAY, ...(id !== openThread && { finishedAt: Date.now() - 10 * DAY }) }),
    archived: (id) => id !== finThread, fin: (id) => id === finThread, ancestorsClosed: () => false,
    whose: () => "makomono", appRunning: async (app) => String(app) === String(runningApp), using: async () => [], openFiles: async () => open, idleDays: async () => 3,
  })
  const items = await retention.items()
  const by = (path: string) => items.find((item) => item.path === path)!
  assert.deepEqual(
    [archivedThread, openThread, finThread, fresh, runningApp, kept].map((id) => by(join(data, id)).class),
    ["now", "keep", "approve", "keep", "keep", "keep"],
    "archived: now; open file, written today, running app, .keep: kept; a Fin under an open Apex: the person's OK",
  )
  assert.equal(by(join(data, folder, "pool")).class, "approve", "a folder's shared app data needs the person's OK")
  assert.deepEqual(by(join(data, archivedThread)).parts, [join(data, archivedThread, "t3bench")], "registered scratch is never part of it")

  const asked = [archivedThread, openThread, fresh, runningApp, kept].map((id) => by(join(data, id)))
  const outcome = await retention.reclaim([...asked, by(join(data, folder, "pool"))], "now")
  assert.equal(outcome.get(by(join(data, archivedThread)).id), true)
  assert.equal(await exists(join(data, archivedThread, "t3bench")), false, "the archived Thread's old folder went")
  assert.equal(await exists(join(data, archivedThread, "scratch")), true, "its registered scratch is the scratch store's")
  for (const id of [openThread, fresh, runningApp, kept]) assert.equal(await exists(join(data, id, "t3bench")), true, `${id}'s stays`)
  assert.equal(await exists(join(data, folder, "pool")), true, "Mako's own pass never takes what needs the OK")

  open = []
  const approved = await retention.reclaim([by(join(data, folder, "pool")), by(join(data, kept)), by(join(data, fresh))], "approve")
  assert.equal(approved.get(by(join(data, folder, "pool")).id), true, "with the person's OK the shared folder goes")
  assert.equal(await exists(join(data, kept, "t3bench")), true, "a .keep holds even with the OK")
  assert.equal(await exists(join(data, fresh, "t3bench", "new")), true, "so does a write from today")
})

test("worktrees: an archived Thread's is retired like a finished Fin's; uncommitted or unpushed work never is", async () => {
  const base = join(root, "worktrees")
  const checkouts = join(base, "checkouts")
  const ids = { clean: thread(), dirty: thread(), unpushed: thread(), personal: thread() }
  const rows: ThreadWorktree[] = []
  for (const [name, id] of Object.entries(ids)) {
    const path = join(checkouts, name)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, "file"), "x")
    await utimes(join(path, "file"), new Date(Date.now() - 30 * DAY), new Date(Date.now() - 30 * DAY))
    rows.push({ path, thread: id, repoRoot: join(base, "repo"), project: join(base, "repo"), branch: name, base: "0".repeat(40), createdAt: Date.now() - 30 * DAY })
  }
  const removed: Array<[string, boolean, boolean | undefined]> = []
  const retention = new WorktreeRetention({
    file: join(base, "settings.json"), root: checkouts, worktrees: () => rows, finished: () => Date.now() - 20 * DAY,
    archived: (id) => id !== ids.personal, title: (id) => `Thread ${id.slice(0, 4)}`,
    using: async () => [], openFiles: async () => [],
    repository: async (row) => ({
      head: "1".repeat(40),
      blocked: row.thread === ids.dirty ? "The checkout has uncommitted changes." : null,
      remote: row.thread !== ids.unpushed,
      ignored: [],
    }),
    fetch: async () => {},
    remove: async (path, finished, person) => { removed.push([path, finished, person]) },
    packagesRemoved: async () => {},
  })
  const items = await retention.items()
  const classOf = (name: string) => items.find((item) => item.path === join(checkouts, name))?.class
  assert.deepEqual(["clean", "dirty", "unpushed", "personal"].map(classOf), ["now", "keep", "keep", "approve"])

  await retention.run()
  assert.deepEqual(removed, [[join(checkouts, "clean"), true, undefined]], "the pass retires the archived Thread's clean, pushed one, recorded to be made again")
  removed.length = 0
  const asked = items.filter((item) => item.class !== "now")
  const outcome = await retention.reclaim(asked.map((item) => ({ ...item, class: "approve" })), "approve")
  assert.deepEqual(removed, [[join(checkouts, "personal"), true, true]], "with the OK only the clean, pushed one goes")
  assert.match(String(outcome.get(`worktrees:${join(checkouts, "dirty")}`)), /uncommitted/)
  assert.match(String(outcome.get(`worktrees:${join(checkouts, "unpushed")}`)), /remote/)
  retention.close()
})

/** A store whose items stand still and whose removal frees `bytes` of the fake disk. */
function fakeStore(store: ReclaimStore, items: ReclaimItem[], disk: { free: number }, refuse = new Set<string>()): StorageReclaimer & { asked: string[] } {
  const asked: string[] = []
  return {
    store, asked,
    items: async () => items.map((item) => ({ ...item })),
    reclaim: async (chosen, consent) => new Map(chosen.map((item): [string, true | string] => {
      asked.push(item.id)
      if (refuse.has(item.id)) return [item.id, "A provider, terminal or process has it open."]
      if (item.class === "keep" || (item.class === "approve" && consent === "now")) return [item.id, "Not within consent."]
      disk.free += item.bytes ?? 0
      items.splice(items.findIndex((row) => row.id === item.id), 1)
      return [item.id, true]
    })),
  }
}

const row = (store: ReclaimStore, name: string, gb: number, kind: ReclaimItem["class"], usedDaysAgo: number): ReclaimItem => ({
  id: `${store}:/${name}`, store, path: `/${name}`, label: name, bytes: gb * GB, usedAt: Date.now() - usedDaysAgo * DAY, class: kind, reason: kind,
})

test("the disk budget frees what is expendable now, oldest first, until the disk has room, and says so", async () => {
  const total = 926 * GB, low = storageLowBytes(total)
  assert.equal(low, 30 * GB, "5% of the disk, at most 30 GB")
  assert.equal(storageLowBytes(256 * GB), 15 * GB, "at least 15 GB")
  const disk = { free: low - 10 * GB }
  const scratch = fakeStore("scratch", [row("scratch", "old", 4, "now", 30), row("scratch", "newer", 20, "now", 5), row("scratch", "newest", 20, "now", 1)], disk)
  const worktrees = fakeStore("worktrees", [row("worktrees", "oldest", 3, "now", 60), row("worktrees", "personal", 40, "approve", 90), row("worktrees", "dirty", 50, "keep", 99)], disk)
  const events: HostEvent[] = []
  const storage = new MakoStorage({
    roots: ["/user"], collectors: () => [], reclaimers: () => [scratch, worktrees], emit: (event) => events.push(event),
    measure: async () => new Map(), measureFolder: async () => 0, disk: async () => ({ freeBytes: disk.free, totalBytes: total }),
  })
  await storage.watch()
  assert.deepEqual([...worktrees.asked, ...scratch.asked], ["worktrees:/oldest", "scratch:/old", "scratch:/newer"], "oldest first, and only until over the line with room")
  assert.ok(disk.free >= low, "the disk is back over the line")
  assert.equal(events.length, 1)
  const notice = events[0]
  assert.ok(notice?.type === "notice" && notice.level === "info", "told, not warned")
  assert.match(notice.message, /Mako freed 27\.0 GB: 1 worktree, 2 Threads' scratch/)
  assert.deepEqual(notice.action, { label: "See what went", does: "open-storage" })
  const report = storage.report()
  assert.equal(report.reclaims[0]?.trigger, "low disk")
  assert.equal(report.reclaims[0]?.removed.length, 3, "Settings › Storage lists the pass as one")

  // Nothing expendable left that frees enough: what needs the OK and what's kept stay, and the person is warned.
  disk.free = low + 5 * GB
  await storage.watch()
  disk.free = low - 30 * GB
  await storage.watch()
  assert.ok(!worktrees.asked.includes("worktrees:/personal") && !worktrees.asked.includes("worktrees:/dirty"), "never what needs the OK or is kept")
  assert.ok(events.some((event) => event.type === "notice" && event.level === "error"), "still under the line: warned, with Settings › Storage to choose the rest")
})

test("the disk budget never takes what a fresh look finds in use, and stays off when the person turns it off", async () => {
  const total = 926 * GB, low = storageLowBytes(total)
  const disk = { free: low - 5 * GB }
  const busy = row("scratch", "busy", 9, "now", 40)
  const scratch = fakeStore("scratch", [busy, row("scratch", "idle", 9, "now", 20)], disk, new Set([busy.id]))
  const events: HostEvent[] = []
  const storage = new MakoStorage({
    roots: ["/user"], collectors: () => [], reclaimers: () => [scratch], emit: (event) => events.push(event), budgetFile: join(root, "budget.json"),
    measure: async () => new Map(), measureFolder: async () => 0, disk: async () => ({ freeBytes: disk.free, totalBytes: total }),
  })
  await storage.watch()
  const pass = storage.report().reclaims[0]!
  assert.deepEqual(pass.removed.map((item) => item.label), ["idle"])
  assert.deepEqual(pass.kept.map((item) => [item.label, item.reason]), [["busy", "A provider, terminal or process has it open."]], "a turn's scratch looked at again stays")

  await storage.configureBudget({ autoFree: false })
  const off = fakeStore("scratch", [row("scratch", "another", 9, "now", 40)], disk)
  const again = new MakoStorage({
    roots: ["/user"], collectors: () => [], reclaimers: () => [off], emit: () => {}, budgetFile: join(root, "budget.json"),
    measure: async () => new Map(), measureFolder: async () => 0, disk: async () => ({ freeBytes: low - 5 * GB, totalBytes: total }),
  })
  await again.watch()
  assert.deepEqual(off.asked, [], "with the switch off nothing goes by itself")
  assert.equal((await again.budget()).autoFree, false, "the switch is kept for the next host")
  assert.ok(await readdir(root).then((names) => names.includes("budget.json")))
})

test("the person's removal goes within what they agreed to", async () => {
  const disk = { free: 100 * GB }
  const store = fakeStore("worktrees", [row("worktrees", "now", 1, "now", 9), row("worktrees", "ok", 2, "approve", 9), row("worktrees", "kept", 3, "keep", 9)], disk)
  const storage = new MakoStorage({
    roots: ["/user"], collectors: () => [], reclaimers: () => [store], emit: () => {},
    measure: async () => new Map(), measureFolder: async () => 0, disk: async () => ({ freeBytes: disk.free, totalBytes: 926 * GB }),
  })
  const plan = await storage.plan()
  const ids = plan.items.map((item) => item.id)
  await storage.reclaim("now", ids)
  assert.deepEqual(store.asked, ["worktrees:/now"], "Remove under Safe to remove now takes only those")
  await storage.reclaim("approve", ids)
  assert.deepEqual(store.asked, ["worktrees:/now", "worktrees:/ok"], "Needs your OK adds those; Kept never goes")
  assert.deepEqual((await storage.plan()).items.map((item) => item.label), ["kept"])
})
