import { mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import type { ThreadRef } from "@mako/sessions"
import {
  SessionSettingsSchema,
  type SessionSettings,
} from "@mako/sessions/settings"
import { heldReason } from "./contracts/session-hold.js"
import { hostWarn } from "./host-log.js"

/**
 * What Mako knows about a native session that its provider's store does not
 * record, kept once per user so every Mako host on this Mac reads the same
 * facts.
 *
 * A live session reports its model, options and access mode to the host that
 * runs it, and that host journals them under its own data root. The installed
 * app and a development host each have such a root while both catalogue the
 * same provider stores, so a thread started in one read "Model not recorded"
 * with no access level in the other; Cursor's ACP store writes neither fact,
 * so its rows read that way after any restart that lost the journal too. The
 * same two hosts could each open a `cursor-agent` on one `store.db`, because
 * nothing outside a host knew the session was already live.
 *
 * This ledger is the one place both facts live: the settings and access mode
 * last observed for each (provider, native session), and which host currently
 * holds the session live. Every provider is treated the same way; the store's
 * own record still wins whenever it names a model, and the ledger fills what
 * the store left out (`rememberedSettings`).
 *
 * Holds are leases, not locks: a hold names its host by pid and start time,
 * is heartbeated while the host runs, and is ignored once the pid is gone or
 * the heartbeat is older than `HOLD_STALE_MS`, so a crashed host never pins a
 * session. Writers serialize through SQLite's write lock, so two hosts racing
 * to open one session see one winner.
 */
const MemoryRowSchema = z.object({
  settings: z.string().nullable(),
  mode_id: z.string().nullable(),
  updated_at: z.number(),
})
const HoldRowSchema = z.object({
  host_pid: z.number().int(),
  host_started_at: z.number(),
  host_label: z.string(),
  conversation_id: z.string(),
  since: z.number(),
  heartbeat_at: z.number(),
})

export interface SessionMemoryEntry {
  settings?: SessionSettings
  modeId?: string
  updatedAt: number
}

export interface SessionHold {
  hostLabel: string
  hostPid: number
  conversationId: string
  since: number
}

export interface ConversationEndpoint {
  conversationId: string
  socket: string
}

export interface ConversationRoute extends ConversationEndpoint {
  provider: string
  nativeId: string
}

const RouteSchema = z.object({
  conversationId: z.string(), provider: z.string(), nativeId: z.string(), socket: z.string(),
})

const RuntimeLaunchSchema = z.object({
  dataRoot: z.string(), executable: z.string(), args: z.array(z.string()), cwd: z.string(), profile: z.string(),
})
export type RuntimeLaunch = z.infer<typeof RuntimeLaunchSchema>

export interface SessionMemoryHost {
  pid: number
  startedAt: number
  socket?: string
  launch?: RuntimeLaunch
  /** How another host names this one in a refusal: "the installed Mako app". */
  label: string
}

export interface SessionMemoryOptions {
  now?: () => number
  alive?: (pid: number) => boolean
}

export const HOLD_STALE_MS = 3 * 60_000
export const HOLD_HEARTBEAT_MS = 30_000
export const ANNOTATION_CACHE_MS = 2_000

export class SessionHeldError extends Error {
  readonly hold: SessionHold
  constructor(hold: SessionHold) {
    super(heldReason(hold.hostLabel))
    this.name = "SessionHeldError"
    this.hold = hold
  }
}

/** What a session reported and a journal or ledger keeps: each fact is optional and independent. */
export interface SessionFacts {
  settings?: SessionSettings
  modeId?: string
}

export function sessionMemoryPath(home = homedir()): string {
  return join(home, ".mako", "session-memory.sqlite")
}

function parseSettings(text: string): SessionSettings | null {
  try {
    const parsed = SessionSettingsSchema.safeParse(JSON.parse(text))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH")
  }
}

export class SessionMemory {
  readonly path: string
  private readonly db: DatabaseSync
  private readonly host: SessionMemoryHost
  private readonly now: () => number
  private readonly alive: (pid: number) => boolean
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly annotations = new Map<string, { at: number; entry: SessionMemoryEntry | null; hold: SessionHold | null }>()

  constructor(path: string, host: SessionMemoryHost, options: SessionMemoryOptions = {}) {
    this.path = path
    this.host = host
    this.now = options.now ?? Date.now
    this.alive = options.alive ?? processAlive
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runtime_hosts (socket TEXT PRIMARY KEY, launch TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_journals (conversation_id TEXT PRIMARY KEY, socket TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversation_routes (
        conversation_id TEXT PRIMARY KEY, provider TEXT NOT NULL, native_id TEXT NOT NULL, socket TEXT NOT NULL, updated_at INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS conversation_routes_native ON conversation_routes(provider, native_id);
      CREATE TABLE IF NOT EXISTS memory (
        provider TEXT NOT NULL, native_id TEXT NOT NULL,
        settings TEXT, mode_id TEXT, updated_at INTEGER NOT NULL,
        PRIMARY KEY (provider, native_id));
      CREATE TABLE IF NOT EXISTS holds (
        provider TEXT NOT NULL, native_id TEXT NOT NULL,
        host_pid INTEGER NOT NULL, host_started_at INTEGER NOT NULL, host_label TEXT NOT NULL,
        conversation_id TEXT NOT NULL, since INTEGER NOT NULL, heartbeat_at INTEGER NOT NULL,
        PRIMARY KEY (provider, native_id));`)
      // Hosts share this ledger across builds. Lock before inspecting so two
      // hosts cannot both try to add the column during an upgrade.
      this.db.exec("BEGIN IMMEDIATE")
      if (!this.db.prepare("PRAGMA table_info(conversation_routes)").all().some((column) => column.name === "updated_at"))
        this.db.exec("ALTER TABLE conversation_routes ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0")
      this.db.exec("COMMIT")
      if (host.socket && host.launch)
        this.db.prepare("INSERT INTO runtime_hosts (socket, launch) VALUES (?, ?) ON CONFLICT(socket) DO UPDATE SET launch=excluded.launch")
          .run(host.socket, JSON.stringify(host.launch))
    } catch (error) {
      this.db.close()
      throw error
    }
  }

  /** Keep this host's holds fresh for as long as it runs. */
  startHeartbeat(intervalMs = HOLD_HEARTBEAT_MS): void {
    if (this.timer) return
    this.timer = setInterval(() => this.heartbeat(), intervalMs)
    this.timer.unref()
  }

  recall(provider: string, nativeId: string): SessionMemoryEntry | null {
    const row = this.db
      .prepare("SELECT settings, mode_id, updated_at FROM memory WHERE provider = ? AND native_id = ?")
      .get(provider, nativeId)
    if (!row) return null
    const parsed = MemoryRowSchema.safeParse(row)
    if (!parsed.success) return null
    const entry: SessionMemoryEntry = { updatedAt: parsed.data.updated_at }
    if (parsed.data.settings) {
      const settings = parseSettings(parsed.data.settings)
      if (settings) entry.settings = settings
    }
    if (parsed.data.mode_id) entry.modeId = parsed.data.mode_id
    return entry
  }

  /**
   * Record what a session reported. Each fact replaces the previous value of
   * the same fact; a fact not given is left as it was, so a mode change does
   * not erase the settings and a settings report does not erase the mode.
   */
  remember(
    provider: string,
    nativeId: string,
    facts: { settings?: SessionSettings; modeId?: string | null },
    at = this.now()
  ): void {
    if (facts.settings === undefined && facts.modeId === undefined) return
    const previous = this.recall(provider, nativeId)
    const settings = facts.settings ?? previous?.settings
    const modeId = facts.modeId === undefined ? previous?.modeId : facts.modeId
    if (
      previous &&
      JSON.stringify(previous.settings ?? null) === JSON.stringify(settings ?? null) &&
      (previous.modeId ?? null) === (modeId ?? null)
    )
      return
    this.db
      .prepare(
        `INSERT INTO memory (provider, native_id, settings, mode_id, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (provider, native_id) DO UPDATE SET settings = excluded.settings, mode_id = excluded.mode_id, updated_at = excluded.updated_at`
      )
      .run(provider, nativeId, settings ? JSON.stringify(settings) : null, modeId ?? null, at)
    this.annotations.delete(`${provider}\n${nativeId}`)
  }

  /**
   * Record what a host's own journal remembers from before the ledger
   * existed, stamped with the journal's write time. It fills a session the
   * ledger has never heard of and never overrides an observation newer than
   * the journal, so a host started later cannot roll another's facts back.
   */
  backfill(provider: string, nativeId: string, facts: SessionFacts, at: number): boolean {
    if (facts.settings === undefined && facts.modeId === undefined) return false
    const previous = this.recall(provider, nativeId)
    if (previous && previous.updatedAt >= at) return false
    this.remember(provider, nativeId, facts, at)
    return true
  }

  /** Another host's live hold on this session, or null when none, ours, or stale. */
  owns(provider: string, nativeId: string, conversationId: string): boolean {
    const row = this.readHold(provider, nativeId)
    return row !== null && this.ownHold(row) && row.conversation_id === conversationId
  }

  heldBy(provider: string, nativeId: string): SessionHold | null {
    const row = this.readHold(provider, nativeId)
    if (!row) return null
    if (this.ownHold(row)) return null
    if (this.holdLive(row)) return this.describe(row)
    this.db.prepare("DELETE FROM holds WHERE provider = ? AND native_id = ? AND host_pid = ? AND host_started_at = ?").run(provider, nativeId, row.host_pid, row.host_started_at)
    return null
  }

  /**
   * Take the session for `conversationId` on this host. Throws
   * `SessionHeldError` while another running host holds it; a hold from a
   * host that is gone is taken over.
   */
  hold(provider: string, nativeId: string, conversationId: string): void {
    const at = this.now()
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const row = this.readHold(provider, nativeId)
      if (
        row &&
        (!this.ownHold(row) || row.conversation_id !== conversationId) &&
        this.holdLive(row)
      )
        throw new SessionHeldError(this.describe(row))
      const since = row && this.ownHold(row) ? row.since : at
      this.db
        .prepare(
          `INSERT INTO holds (provider, native_id, host_pid, host_started_at, host_label, conversation_id, since, heartbeat_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (provider, native_id) DO UPDATE SET host_pid = excluded.host_pid, host_started_at = excluded.host_started_at, host_label = excluded.host_label, conversation_id = excluded.conversation_id, since = excluded.since, heartbeat_at = excluded.heartbeat_at`
        )
        .run(provider, nativeId, this.host.pid, this.host.startedAt, this.host.label, conversationId, since, at)
      if (this.host.socket)
        this.db.prepare(`INSERT INTO conversation_routes (conversation_id, provider, native_id, socket, updated_at) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(conversation_id) DO UPDATE SET provider=excluded.provider, native_id=excluded.native_id, socket=excluded.socket, updated_at=excluded.updated_at`)
          .run(conversationId, provider, nativeId, this.host.socket, at)
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
    this.annotations.delete(`${provider}\n${nativeId}`)
  }

  /**
   * Let go of this host's hold, or only the one `conversationId` took, so a
   * conversation closing late cannot drop a hold a newer one owns. Another
   * host's hold is never touched.
   */
  release(provider: string, nativeId: string, conversationId?: string): void {
    this.annotations.delete(`${provider}\n${nativeId}`)
    if (conversationId === undefined)
      this.db
        .prepare("DELETE FROM holds WHERE provider = ? AND native_id = ? AND host_pid = ? AND host_started_at = ?")
        .run(provider, nativeId, this.host.pid, this.host.startedAt)
    else
      this.db
        .prepare("DELETE FROM holds WHERE provider = ? AND native_id = ? AND host_pid = ? AND host_started_at = ? AND conversation_id = ?")
        .run(provider, nativeId, this.host.pid, this.host.startedAt, conversationId)
  }

  runtimeLaunch(socket: string): RuntimeLaunch | null {
    const row = z.object({ launch: z.string() }).safeParse(this.db.prepare("SELECT launch FROM runtime_hosts WHERE socket = ?").get(socket))
    if (!row.success) return null
    try { return RuntimeLaunchSchema.parse(JSON.parse(row.data.launch)) }
    catch { return null }
  }

  /** An older host can be reached through its existing private runtime socket. */
  rememberRoute(route: ConversationRoute, expected: SessionHold): void {
    this.db.exec("BEGIN IMMEDIATE")
    try {
      const hold = this.heldBy(route.provider, route.nativeId)
      if (!hold || hold.conversationId !== route.conversationId || hold.hostPid !== expected.hostPid || hold.since !== expected.since)
        throw new Error("The session owner changed. Reopen this thread to continue.")
      this.db.prepare(`INSERT INTO conversation_routes (conversation_id, provider, native_id, socket, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET provider=excluded.provider, native_id=excluded.native_id, socket=excluded.socket, updated_at=excluded.updated_at`)
        .run(route.conversationId, route.provider, route.nativeId, route.socket, this.now())
      this.db.exec("COMMIT")
    } catch (error) {
      this.db.exec("ROLLBACK")
      throw error
    }
  }

  /** Journal location survives hibernation and host restart; a route grants no write ownership. */
  rememberJournal(conversationId: string, socket = this.host.socket): void {
    if (!socket) return
    this.db.prepare(`INSERT INTO conversation_journals (conversation_id, socket) VALUES (?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET socket=excluded.socket`).run(conversationId, socket)
  }

  routeForConversation(conversationId: string): ConversationEndpoint | null {
    const journal = z.object({ conversationId: z.string(), socket: z.string() }).safeParse(
      this.db.prepare("SELECT conversation_id AS conversationId, socket FROM conversation_journals WHERE conversation_id = ?").get(conversationId))
    if (journal.success) return journal.data.socket !== this.host.socket ? journal.data : null
    const row = this.db.prepare(`SELECT conversation_id AS conversationId, provider, native_id AS nativeId, socket
      FROM conversation_routes WHERE conversation_id = ?`).get(conversationId)
    const parsed = RouteSchema.safeParse(row)
    return parsed.success && parsed.data.socket !== this.host.socket ? parsed.data : null
  }

  routeForSession(provider: string, nativeId: string): ConversationRoute | null {
    const hold = this.readHold(provider, nativeId)
    if (hold && this.holdLive(hold)) {
      const row = this.db.prepare(`SELECT conversation_id AS conversationId, provider, native_id AS nativeId, socket
        FROM conversation_routes WHERE conversation_id = ?`).get(hold.conversation_id)
      const parsed = RouteSchema.safeParse(row)
      return parsed.success && parsed.data.socket !== this.host.socket ? parsed.data : null
    }
    const row = this.db.prepare(`SELECT conversation_id AS conversationId, provider, native_id AS nativeId, socket
      FROM conversation_routes WHERE provider = ? AND native_id = ? ORDER BY updated_at DESC LIMIT 1`).get(provider, nativeId)
    const parsed = RouteSchema.safeParse(row)
    return parsed.success && parsed.data.socket !== this.host.socket ? parsed.data : null
  }

  /** Every hold this host has: what `stop()` lets go of. */
  releaseAll(): void {
    this.annotations.clear()
    this.db.prepare("DELETE FROM holds WHERE host_pid = ? AND host_started_at = ?").run(this.host.pid, this.host.startedAt)
  }

  heartbeat(at = this.now()): void {
    try {
      this.db.prepare("UPDATE holds SET heartbeat_at = ? WHERE host_pid = ? AND host_started_at = ?").run(at, this.host.pid, this.host.startedAt)
    } catch (error) {
      hostWarn("memory", "heartbeat failed", { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /**
   * Overlay what the ledger knows onto a catalogued ref. The catalog is
   * served hundreds of refs at a time, so answers are held briefly; another
   * host's write becomes visible within `ANNOTATION_CACHE_MS`, this host's
   * own writes at once.
   */
  annotate(ref: ThreadRef): ThreadRef {
    const key = `${ref.harness}\n${ref.nativeId}`
    const now = this.now()
    let known = this.annotations.get(key)
    if (!known || now - known.at > ANNOTATION_CACHE_MS) {
      known = { at: now, entry: this.recall(ref.harness, ref.nativeId), hold: this.heldBy(ref.harness, ref.nativeId) }
      this.annotations.set(key, known)
    }
    const { entry, hold } = known
    if (!entry && !hold) return ref
    let next = ref
    if (entry?.settings) {
      const settings = rememberedSettings(ref, entry)
      if (settings !== ref.settings) next = { ...next, settings, model: settings.model ?? next.model }
    }
    if (entry?.modeId) next = { ...next, accessMode: entry.modeId }
    if (hold) next = { ...next, heldBy: hold.hostLabel }
    return next
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.db.close()
  }

  private readHold(provider: string, nativeId: string): z.infer<typeof HoldRowSchema> | null {
    const row = this.db
      .prepare("SELECT host_pid, host_started_at, host_label, conversation_id, since, heartbeat_at FROM holds WHERE provider = ? AND native_id = ?")
      .get(provider, nativeId)
    if (!row) return null
    const parsed = HoldRowSchema.safeParse(row)
    return parsed.success ? parsed.data : null
  }

  private ownHold(row: z.infer<typeof HoldRowSchema>): boolean {
    return row.host_pid === this.host.pid && row.host_started_at === this.host.startedAt
  }

  private holdLive(row: z.infer<typeof HoldRowSchema>): boolean {
    return this.now() - row.heartbeat_at <= HOLD_STALE_MS && this.alive(row.host_pid)
  }

  private describe(row: z.infer<typeof HoldRowSchema>): SessionHold {
    return { hostLabel: row.host_label, hostPid: row.host_pid, conversationId: row.conversation_id, since: row.since }
  }
}

/**
 * The settings a catalogued ref should show given what its store recorded and
 * what Mako remembered. The store wins whenever it names a model, because it
 * is written by the provider on every turn, including turns run outside Mako;
 * the ledger fills a store that records nothing (Cursor) and the options a
 * store records without (Devin's model-only row), and overrides the store
 * only when Mako's observation is newer than the store's last write.
 */
export function rememberedSettings(
  ref: Pick<ThreadRef, "model" | "settings" | "updatedAt">,
  remembered: SessionMemoryEntry
): SessionSettings {
  const native: SessionSettings = ref.settings ?? (ref.model ? { model: ref.model } : {})
  const recalled = remembered.settings
  if (!recalled) return native
  if (!native.model) return recalled
  if (native.model === recalled.model) {
    const merged: SessionSettings = { model: native.model }
    if (recalled.options || native.options) merged.options = { ...recalled.options, ...native.options }
    return merged
  }
  const storeWrote = ref.updatedAt ? Date.parse(ref.updatedAt) : Number.NaN
  return Number.isFinite(storeWrote) && remembered.updatedAt > storeWrote ? recalled : native
}
