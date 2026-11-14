import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs"
import { join, resolve } from "node:path"
import { hostname } from "node:os"
import { randomUUID } from "node:crypto"
import { DatabaseSync } from "node:sqlite"
import { acquireHostLock } from "../base/host-lock.js"
import { hostLog, hostWarn } from "../base/host-log.js"
import { vacuumIfSparse } from "./journal-vacuum.js"
import { SharedJournal, sharedJournalFolder, ownerAddress, type JournalWrites, type OwnedJournal } from "./shared-journal.js"
import { LaptopTracker } from "./tracker.js"
import { nodeFileSystem, watcherEvents } from "./ports.js"
import { ChildCalls } from "./child-calls.js"
import { Backfill, type BackfillResult } from "./backfill.js"
import { carryHistory } from "./thread-history.js"
import { lostVersions, restoreVersion } from "./recovery.js"
import type { JournalView } from "./queries.js"
import { within } from "./paths.js"
import { rootId, sessionFolders, sessionIds, outsideFolders, harnessScratch, type CataloguedSession } from "./writer-paths.js"
import type { WriterSettings, WriterPorts, WriterSnapshot, WriterCommand, WriterCommandResult } from "./writer-protocol.js"

const DAY_MS = 86_400_000
const RETENTION_DAYS = 14
const OUTSIDERS_FRESH_MS = 2_000
interface WriterSharing { journal?: SharedJournal }
interface Local { tracker: LaptopTracker; readBack(folder?: string, budgetMs?: number): Promise<BackfillResult | undefined> }
const liveView = (tracker: LaptopTracker): JournalView => ({ store: tracker.store, roots: () => tracker.rootStates().values(), author: (seq) => tracker.authorOf(seq) })
/** A journal's file and its write-ahead log, newest change first. */
function lastWritten(path: string): number {
  let newest = 0
  for (const file of [path, `${path}-wal`]) {
    try {
      newest = Math.max(newest, statSync(file).mtimeMs)
    } catch {
      // Not there.
    }
  }
  return newest
}

/**
 * Start the device's shared journal from the newest journal this device
 * already keeps: another format's shared one, or a host's own from before
 * sharing. Copied as one consistent snapshot, so a Mako still writing its
 * own goes on undisturbed; the tracker then catches up from the history.
 * The copy takes a new journal id: an older Mako may go on appending to the
 * original, and two histories under one id would mislead any peer that asks
 * by number. It's renamed into place whole, so a crash leaves no half copy.
 */
function adoptJournal(folder: string, candidates: readonly string[]): void {
  const target = join(folder, "journal.sqlite")
  if (existsSync(target)) return
  const newest = candidates.filter((path) => path !== target && existsSync(path)).sort((a, b) => lastWritten(b) - lastWritten(a))[0]
  if (!newest) return
  const began = Date.now()
  const copying = `${target}.copying`
  try {
    mkdirSync(folder, { recursive: true })
    rmSync(copying, { force: true })
    const source = new DatabaseSync(newest, { readOnly: true })
    try {
      source.exec(`VACUUM INTO '${copying.replaceAll("'", "''")}'`)
    } finally {
      source.close()
    }
    const copy = new DatabaseSync(copying)
    try {
      copy.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('journal', ?)").run(randomUUID())
    } finally {
      copy.close()
    }
    renameSync(copying, target)
    hostLog("attribution", "the device's record of changes started from an existing one", { from: newest, ms: Date.now() - began })
  } catch (error) {
    rmSync(copying, { force: true })
    hostWarn("attribution", "an existing record of changes couldn't be copied; starting a new one", { from: newest, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Journals in other formats' folders, each with its folder. */
function otherFormats(userRoot: string, folder: string): { folder: string; journal: string }[] {
  const parent = join(userRoot, "attribution")
  try {
    return readdirSync(parent, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && /^[0-9a-f]{16}$/.test(entry.name) && join(parent, entry.name) !== folder)
      .map((entry) => ({ folder: join(parent, entry.name), journal: join(parent, entry.name, "journal.sqlite") }))
  } catch {
    return []
  }
}

/**
 * Remove journals nothing has written for longer than retention: other
 * formats' shared ones nobody owns, and this host's own from before sharing.
 * A Mako still using one writes it, so it's never this old.
 */
async function sweepOldJournals(userRoot: string, folder: string, dataRoot: string, before: number): Promise<string[]> {
  const removed: string[] = []
  for (const other of otherFormats(userRoot, folder)) {
    if (lastWritten(other.journal) > before) continue
    const lock = await acquireHostLock(other.folder, { purpose: "owner" }).catch(() => undefined)
    if (lock?.kind !== "held") continue
    try {
      rmSync(other.folder, { recursive: true, force: true })
      removed.push(other.folder)
    } finally {
      await lock.release()
    }
  }
  const own = join(dataRoot, "attribution", "journal.sqlite")
  if (own !== join(folder, "journal.sqlite") && existsSync(own) && lastWritten(own) <= before) {
    for (const file of [own, `${own}-wal`, `${own}-shm`]) rmSync(file, { force: true })
    removed.push(own)
  }
  return removed
}


/** The writer and its election run in the owned child; the host keeps only a committed read view. */
export async function openWriter(settings: WriterSettings, ports: WriterPorts) {
  const { home, temporary, own } = settings
  const folder = sharedJournalFolder(settings.userRoot)
  const journalFile = join(folder, "journal.sqlite")
  const sharing: WriterSharing = {}
  let local: Local | undefined
  const placed = (sessions: readonly CataloguedSession[]): readonly CataloguedSession[] => {
    const positions = new Map((sharing.journal?.followers() ?? []).flatMap(follower => [...follower.placed]))
    return sessions.map(session => { const position = !session.threadId && positions.get(session.path); return position ? { ...session, threadId: position.thread, sessionId: position.session } : session })
  }
  const catalogued = async () => placed((await ports.context()).sessions)
  let outsiders: { at: number; reading: Promise<readonly { folder: string; why: string }[]> } | undefined
  const outsider = async (path: string, root: string) => {
    const now = Date.now()
    if (!outsiders || now - outsiders.at > OUTSIDERS_FRESH_MS) outsiders = { at: now, reading: ports.context().then(context => {
      const followed = new Set((sharing.journal?.followers() ?? []).flatMap(follower => [...follower.live.keys()]))
      return outsideFolders(placed(context.sessions).filter(session => !followed.has(session.path)), context.running, home)
    }) }
    return (await outsiders.reading).find(item => within(item.folder, path) || within(root, item.folder))?.why
  }
  const openLocal = async (storage: string): Promise<OwnedJournal> => {
    // Only calls into the tracker once a Session's turn marks it, after the tracker opens.
    const children = ports.children && new ChildCalls({
      records: ports.children,
      reported: (call) => tracker.reported(call),
      reconcile: (calls) => tracker.reconcile(calls),
      hold: () => tracker.hold(),
      unsure: () => tracker.unsure(),
      now: () => Date.now(),
      log: (message, facts) => hostWarn("attribution", message, facts),
    })
    const tracker = await LaptopTracker.open(
      {
        fs: nodeFileSystem(),
        events: watcherEvents(ports.watch, ports.history, () => own),
        clock: { now: () => Date.now() },
        storage,
        device: hostname(),
      },
      {
        repository: ports.repository,
        retentionMs: RETENTION_DAYS * DAY_MS,
        budgetBytes: 2 * 1024 ** 3,
        footprint: {
          home,
          roots: [home, ...temporary],
          live: temporary,
          stores: async () => [...(await ports.context()).stores, ...harnessScratch(home), ...own, ...(sharing.journal?.followers() ?? []).map((follower) => follower.host.dataRoot)],
          others: async (thread, since) => { const context = await ports.context(); return sessionFolders(placed(context.sessions), context.running, thread, since) },
          sessions: async (thread) => sessionIds(await catalogued(), thread),
        },
        uncertain: (sessions) => children?.uncertain(sessions),
        outsider: settings.running ? outsider : undefined,
        log: (message, facts) => hostLog("attribution", message, facts),
        deliveryLagMs: ports.deliveryLagMs,
      },
    )
    const backfill = ports.children && settings.catalogued ? new Backfill({
      sessions: catalogued,
      records: ports.children,
      unsure: () => tracker.unsureFiles(),
      reconcile: (calls) => tracker.reconcile(calls),
      now: () => Date.now(),
      log: (message, facts) => hostLog("attribution", message, facts),
    }) : undefined
    const readBack = async (where?: string, budgetMs?: number) => backfill?.run(where, budgetMs).catch((error: Error) => {
      hostWarn("attribution", "records could not be read back", { error: error.message })
      return undefined
    })
    /** Track a root; one tracked anew holds what was there before, which the sessions that worked there may have written. */
    const trackRoot = async (root: string) => {
      const known = tracker.rootStates().size
      await tracker.track({ id: rootId(root), path: root, kind: "workspace" })
      if (tracker.rootStates().size > known) void readBack(root)
    }
    const writing = new Map<string, { end(at?: number): void }>()
    const writes: JournalWrites = {
      activity(mark) {
        tracker.activity(mark)
        children?.marked(mark)
      },
      reported: (call) => tracker.reported(call),
      makoStart: (id, write, at) => {
        writing.set(id, tracker.mako(write, at))
      },
      makoEnd: (id, at) => {
        writing.get(id)?.end(at)
        writing.delete(id)
      },
      makoWrote: (write, startedAt, endedAt) => tracker.makoWrote(write, startedAt, endedAt),
      moved: (move) => tracker.store.saveMove(move),
      chose: (choice) => tracker.store.saveChoice(choice),
      counted: (summary, session) => tracker.store.saveTurnChanges(summary, session),
      async carry(history, map) {
        const result = carryHistory(tracker.store, history, map, Date.now())
        hostLog("attribution", "carried a Thread's file history in", { thread: result.thread, taken: result.taken.length, left: result.left.length, choices: result.choices })
        return result
      },
      // This host's own sessions are in its catalog; a follower's come through `followers()`.
      sessions: () => undefined,
      track: trackRoot,
      settled: (options) => tracker.settled(options),
      readBack: async (where, budgetMs) => {
        await tracker.settled()
        return readBack(where, budgetMs)
      },
      lost: (target) => lostVersions(tracker, liveView(tracker), target),
      async restore(root, entry) {
        const restored = await restoreVersion(tracker, root, entry)
        hostLog("attribution", "restored a version", { path: restored.path, entry })
        return restored
      },
    }
    local = { tracker, readBack }
    // The file stays readable until the tracker has it, so a view never goes missing while the owner changes.
    return {
      writes,
      async close() {
        children?.close()
        if (local?.tracker === tracker) local = undefined
        await tracker.close()
      },
    }
  }


  const privateFolder = join(settings.dataRoot, "attribution", "private")
  const journal = await SharedJournal.open({
    folder, host: { pid: settings.hostPid, dataRoot: settings.dataRoot, label: settings.label },
    privateAddress: ownerAddress(privateFolder),
    privateReason: settings.privateReason,
    own: async () => {
      adoptJournal(folder, [...otherFormats(settings.userRoot, folder).map(other => other.journal), join(settings.dataRoot, "attribution", "journal.sqlite"),
        ...(settings.defaultDataRoot && resolve(settings.userRoot) !== resolve(settings.dataRoot) ? [join(settings.defaultDataRoot, "attribution", "journal.sqlite")] : [])])
      const vacuumed = await vacuumIfSparse(journalFile)
      if (!vacuumed.ok) hostWarn("attribution", "the record of changes could not be compacted; it keeps its free pages", { error: vacuumed.error, ms: vacuumed.ms })
      else if (vacuumed.vacuumed) hostLog("attribution", "the record of changes compacted", { before: vacuumed.bytes, after: vacuumed.after, ms: vacuumed.ms })
      return openLocal(folder)
    },
    follow: () => undefined,
    alone: () => openLocal(privateFolder),
    log: (message, facts) => hostLog("attribution", message, facts),
  })
  sharing.journal = journal
  const followers = () => journal.followers().filter(follower => follower.host.pid !== settings.hostPid || follower.host.dataRoot !== settings.dataRoot)
  const snapshot = (): WriterSnapshot => ({
    path: local?.tracker.store.path ?? journalFile,
    address: journal.role().kind === "private" ? ownerAddress(privateFolder) : ownerAddress(folder),
    role: journal.role(), sharing: { ...journal.status(), followers: followers().map(follower => follower.host) }, followers: followers(),
    recent: (local?.tracker.recent() ?? []).map(({ lagMs, hashMs, diffMs, writeMs }) => ({ lagMs, hashMs, diffMs, writeMs })), rescans: local?.tracker.rescanReading() ?? null,
  })
  const command = async (request: WriterCommand): Promise<WriterCommandResult> => {
    const tracker = local?.tracker
    switch (request.kind) {
      case "snapshot": return snapshot()
      case "wake":
        if (tracker) await Promise.all([...tracker.rootStates().values()].filter(({ root }) => (within(request.checkout, root.path) || within(root.path, request.checkout)) && tracker.asleep(root.path)).map(({ root }) => journal.writes.track(root.path)))
        return
      case "read-back": return local?.readBack()
      case "collect": return tracker?.collectOffThread()
      case "sleep": return tracker?.sleepIdle() ?? []
      case "let-go": return tracker?.letGoIdle() ?? []
      case "sweep": return journal.role().kind === "owner" ? sweepOldJournals(settings.userRoot, folder, settings.dataRoot, Date.now() - RETENTION_DAYS * DAY_MS) : []
      case "close": await journal.close(); return
    }
  }
  const follow = (listener: () => void) => {
    const role = journal.onRole(() => listener())
    const changed = journal.onFollowers(listener)
    return () => { role(); changed() }
  }
  return { snapshot, command, follow, close: () => journal.close() }
}
