import { createReadStream, existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs"
import { mkdir, readFile, readdir, stat } from "node:fs/promises"
import { basename, delimiter, dirname, join, sep } from "node:path"
import { createInterface } from "node:readline"
import { createGunzip } from "node:zlib"
import { z } from "zod"
import { openReadOnly } from "./read-only-sqlite.js"
import { pinnedBy } from "./record-pins.js"
import { npmTimelineKey, readReleaseTimelines, releaseBound, type ReleaseTimelines } from "./record-releases.js"
import { EVIDENCE_RULES, statedVersion, type WriterEvidence } from "./record-writers.js"
import { compareVersions } from "./runtime-version.js"
import { cursorStoreOrigin } from "./providers/cursor-sdk-paths.js"
import type { SessionProvider } from "./providers/types.js"

/**
 * Which build of a harness wrote a session that states none in its records
 * and that Mako never saw run: what the harness leaves beside its store,
 * read only, never guessed (`WriterEvidence`). Per harness:
 *
 * - **Devin CLI** logs every launch to `cli/logs/devin_<time>_<pid>.log[.gz]`,
 *   whose startup line names its version (`init_cli: … version=3000.10.23 …
 *   startup`), and names each session it creates, loads or saves (`Created
 *   new session: <id>`, `loading session <id>`, `Saved N message nodes … for
 *   session <id>`): `log`. Its records state only their schema
 *   (`refinery_schema_history`), which names no release.
 * - **Devin.app** runs its own sessions with the CLI it bundles, and each
 *   launch's `Devin ACP.log` names the binary it spawned (`[devin-cli]
 *   Spawning process: <binary> acp`): a session written only under launches
 *   that spawned one binary, unchanged since before its first write, is
 *   `install` at the version the host read off that binary.
 * - **Grok** logs every process to `logs/unified.jsonl`, each line with its
 *   `pid` and `ver`, and a session's setup and turns with its `sessionId`:
 *   `log`. The file is a short rolling window. Its records state only their
 *   own formats (`chat_format_version`, `schema_version`). Else its installs,
 *   else the newest release npm had published by its last write
 *   (`releaseBound`, a `range` bound by `releases`).
 * - **Cursor's editor** writes a log folder per launch (`logs/<launch time>/`),
 *   whose `main.log` names the version running (`…/update/…/cursor/3.21.18/…`):
 *   a chat written only while one launch's version ran is `install`. Its
 *   `composerData` states only a format (`_v`). Cursor publishes no dated list
 *   of its editor's versions (its changelog dates posts without versions, its
 *   download and update servers answer only the newest), so an older chat
 *   stays `unknown`; no editor chat resumes natively, so none is gated on it.
 * - **`cursor-agent`** keeps each install in `versions/<version>/`, whose
 *   name is its build date (`2026.10.14-0f9edde`): a session can't have been
 *   written by a build dated after its last write, a `range` bound by
 *   `build-day`. Its stores state no client version, in `meta` or in any blob.
 * - **Mako's own Cursor SDK agents** from before their streams named the
 *   SDK: the newest `@cursor/sdk` Mako's repository had pinned by the
 *   agent's last write (`record-pins.ts`), a `range` bound by `pins`.
 * - **Every harness:** the installs there were while the session was written
 *   (`installTimeline`). `install` only when every install of the harness on
 *   PATH and in its own folders is known over the whole time it was written
 *   and all were one version.
 */

/** Where a reader looks: the home the stores are under, the host's installed readings, and the folders a CLI can be run from. */
export interface EvidenceContext {
  home: string
  /** `runtime-updates.json` (`makoRuntimeReadings()`): a binary's version, read by the host, while it's unchanged. */
  readings?: string | null
  /** The folders a harness's CLI may be run from, in place of `PATH` and the folders installers use (a test's own). */
  path?: readonly string[]
  /** Where a reader keeps what it learned of logs that no longer change (a gzipped log), so the next pass reads only new ones. */
  cache?: string | null
  /** Where a harness installs its CLI outside PATH, by harness: Devin.app's bundled CLI by default. */
  binaries?: Partial<Record<string, readonly string[]>>
  /** When each harness's releases were published (`record-releases.ts`); read from `cache` when left out. */
  releases?: ReleaseTimelines
}

const DAY_MS = 24 * 60 * 60 * 1000

/** When a session was first and last written, as its store says. */
interface Writes {
  first: number
  last: number
}

/** What a store's reader asks for its sessions (`SessionProvider.writerEvidence`): one way of looking per kind of store. */
export interface WriterEvidenceLookups {
  devinCli(path: string): Promise<WriterEvidence | null>
  devinApp(path: string): Promise<WriterEvidence | null>
  grokSession(path: string): Promise<WriterEvidence | null>
  cursorStore(path: string): Promise<WriterEvidence | null>
}

/**
 * One reader per pass: it reads each harness's logs and install folders once,
 * then answers for every session of that harness.
 */
export class WriterEvidenceReader implements WriterEvidenceLookups {
  private devinLogs: Promise<Map<string, Set<string>>> | null = null
  private grokLogs: Promise<Map<string, Set<string>>> | null = null
  private readonly timelines = new Map<string, InstallTimeline>()
  private readonly launches = new Map<string, DevinAppLaunch[]>()
  private readonly releases: ReleaseTimelines

  constructor(private readonly context: EvidenceContext) {
    this.releases = context.releases ?? (context.cache ? readReleaseTimelines(context.cache) : {})
  }

  /**
   * The evidence for the session at `path`, as its store's reader declares
   * where to look (`SessionProvider.writerEvidence`), or null for a store
   * this reads nothing of: its records or Mako's streams say.
   */
  async evidence(provider: Pick<SessionProvider, "writerEvidence">, path: string): Promise<WriterEvidence | null> {
    const found = await (provider.writerEvidence?.(path, this) ?? Promise.resolve(null))
    return found && { ...found, rules: EVIDENCE_RULES }
  }

  /** A Devin CLI session (`sessions.db#<id>`): its logs, else its installs. */
  async devinCli(path: string): Promise<WriterEvidence | null> {
    const hash = path.lastIndexOf("#")
    if (hash < 0) return null
    const database = path.slice(0, hash)
    const id = path.slice(hash + 1)
    const writes = devinWrites(database, id)
    if (!writes) return null
    this.devinLogs ??= devinLogIndex(join(dirname(database), "logs"), this.context.cache ? join(this.context.cache, "devin-logs.json") : null)
    const versions = (await this.devinLogs).get(id)
    if (versions?.size) return { source: "log", versions: ordered(versions), writes, why: `Devin CLI's logs in ${join(dirname(database), "logs")} name it and the version of each process that wrote it`, at: Date.now() }
    return this.installed("devin", writes, ["devin"], this.context.binaries?.devin ?? [DEVIN_APP_CLI], null)
  }

  /**
   * A Devin.app session (`<user data>/User/acp-messages/<id>.db`, or its
   * journal): the CLI each of Devin.app's launches spawned while it was
   * written, from the launch's own log, and that binary's version while it's
   * been unchanged since before the session's first write.
   */
  async devinApp(path: string): Promise<WriterEvidence | null> {
    const writes = fileWrites(path)
    if (!writes) return null
    // `<user data>/User/acp-messages/<id>.db`: the launch logs are `<user data>/logs/`.
    const logs = join(dirname(dirname(dirname(path))), "logs")
    let launches = this.launches.get(logs)
    if (!launches) {
      launches = devinAppLaunches(logs)
      this.launches.set(logs, launches)
    }
    const unknown = (why: string): WriterEvidence => ({ source: "unknown", writes, why, at: Date.now() })
    const first = launches[0]
    if (!first || first.since > writes.first) return unknown(`Devin.app's launch logs in ${logs} begin ${first ? new Date(first.since).toISOString() : "nowhere"}, after the session was first written`)
    const during = launches.filter((launch, index) => launch.since <= writes.last && (launches[index + 1]?.since ?? Infinity) > writes.first)
    const binaries = new Set(during.map((launch) => launch.binary))
    const [binary] = binaries
    if (binaries.size !== 1 || !binary) return unknown(`Devin.app's launches while the session was written spawned ${[...binaries].map((each) => each ?? "a CLI their logs don't name").join(" and ")}`)
    const located = installTimeline([], [binary], null, this.context)
    if (!located.ok) return unknown(located.why)
    const since = located.found[0]?.timeline[0]
    if (!since) return unknown(`${binary}, which Devin.app spawned, is gone, so its version can't be read`)
    if (since.since > writes.first) return unknown(`${binary} was replaced ${new Date(since.since).toISOString()}, after the session was first written`)
    return { source: "install", versions: [since.version], writes, why: `every Devin.app launch in ${logs} while the session was written spawned ${binary}, unchanged since ${new Date(since.since).toISOString()} and read as ${since.version}`, at: Date.now() }
  }

  /** A Grok session (`<grok home>/sessions/<cwd>/<id>/updates.jsonl`): its unified log, else its installs, else its release dates. */
  async grokSession(path: string): Promise<WriterEvidence | null> {
    if (basename(path) !== "updates.jsonl") return null
    const folder = dirname(path)
    const id = basename(folder)
    // `<grok home>/sessions/<encoded working directory>/<id>/updates.jsonl`
    const grok = dirname(dirname(dirname(folder)))
    const writes = grokWrites(folder)
    if (!writes) return null
    const logs = join(grok, "logs")
    this.grokLogs ??= grokLogIndex([join(logs, "unified.jsonl.1"), join(logs, "unified.jsonl")])
    const versions = (await this.grokLogs).get(id)
    if (versions?.size) return { source: "log", versions: ordered(versions), writes, why: `Grok's log ${join(logs, "unified.jsonl")} names the session and the version of each process that wrote it`, at: Date.now() }
    // Grok keeps the build it runs and the one before in `bin/` (`grok-<version>`), and drops older ones: what's there is its newest installs, in order.
    const installed = await this.installed("grok", writes, ["grok"], this.context.binaries?.grok ?? [], { versioned: [join(grok, "bin")], npm: GROK_NPM })
    return installed.source === "install" ? installed : this.released(GROK_NPM, writes, installed.why)
  }

  /** The newest release of `npmPackage` published by a day after the last write, a `range`; else `unknown` with `before`, why nothing narrower was found. */
  private released(npmPackage: string, writes: Writes, before: string): WriterEvidence {
    const bound = releaseBound(this.releases[npmTimelineKey(npmPackage)], writes.last)
    if (!bound.ok) return { source: "unknown", writes, why: `${before}; ${bound.why}`, at: Date.now() }
    return {
      source: "range", bound: "releases", upTo: bound.upTo, writes,
      why: `${bound.upTo} (published ${new Date(bound.newest.at).toISOString()}) is the newest ${npmPackage} npm had published by a day after the last write, ${new Date(writes.last).toISOString()}; ${before}`,
      at: Date.now(),
    }
  }

  /** A `cursor-agent` store, a Cursor editor chat or one of Mako's own SDK agents: their installs or launches, else the day bound, else Mako's pins. */
  async cursorStore(path: string): Promise<WriterEvidence | null> {
    const composer = path.indexOf("#composer:")
    if (composer > 0) return this.cursorEditor(path.slice(0, composer), path.slice(composer + "#composer:".length))
    if (basename(path) !== "store.db") return null
    if (cursorStoreOrigin(path, { home: this.context.home })?.origin === "sdk") return makoSdkAgent(path)
    const cursor = join(this.context.home, ".cursor")
    if (!path.startsWith(join(cursor, "chats") + sep) && !path.startsWith(join(cursor, "acp-sessions") + sep)) return null
    const writes = cursorWrites(path)
    if (!writes) return null
    const versions = join(this.context.home, ".local", "share", "cursor-agent", "versions")
    const installed = await this.installed("cursor-agent", writes, ["cursor-agent"], this.context.binaries?.cursor ?? [], { versionFolders: versions })
    if (installed.source === "install") return { ...installed, line: "cursor-agent" }
    // `cursor-agent` names each build by its date: nothing built after the day it was last written (a day's margin for time zones) wrote it.
    const upTo = cursorAgentDay(writes.last + DAY_MS)
    return { source: "range", bound: "build-day", line: "cursor-agent", upTo, writes, why: `cursor-agent names each build by the day it was built (${versions}), and the session was last written ${new Date(writes.last).toISOString().slice(0, 10)}; ${installed.why}`, at: Date.now() }
  }

  /** A Cursor editor chat: the version each launch ran, from its launch logs, over the chat's writes. */
  private async cursorEditor(database: string, id: string): Promise<WriterEvidence | null> {
    if (!existsSync(database)) return null
    const writes = cursorEditorWrites(database, id)
    if (!writes) return { source: "unknown", why: `Cursor's record of the chat (composerData:${id} in ${database}) names no time it was created`, at: Date.now() }
    // `<user data>/User/globalStorage/state.vscdb`: the launch logs are `<user data>/logs/`.
    const logs = join(dirname(dirname(dirname(database))), "logs")
    const launches = cursorLaunches(logs)
    const unknown = (why: string): WriterEvidence => ({ source: "unknown", writes, why, at: Date.now() })
    const first = launches[0]
    if (!first || first.since > writes.first) return unknown(`Cursor's launch logs in ${logs} begin ${first ? new Date(first.since).toISOString() : "nowhere"}, after the chat was first written, and Cursor publishes no dated list of its editor's versions to bound it by`)
    const during = launches.filter((launch, index) => launch.since <= writes.last && (launches[index + 1]?.since ?? Infinity) > writes.first)
    const versions = new Set(during.map((launch) => launch.version))
    if (versions.has(null) || versions.size !== 1) return unknown(`Cursor's launches while the chat was written ran ${[...versions].map((version) => version ?? "a version its log doesn't name").join(" and ")}`)
    const [version] = versions
    return { source: "install", versions: [version!], writes, why: `every Cursor launch in ${logs} from before the chat's first write to its last ran ${version}`, at: Date.now() }
  }

  /**
   * The only version installed over the whole time the session was written,
   * across every install of the harness this can find, or `unknown` with why.
   */
  private async installed(harness: string, writes: Writes, bins: readonly string[], declared: readonly (string | null)[], layout: Layout | null): Promise<WriterEvidence> {
    const key = harness
    let locations = this.timelines.get(key)
    if (locations === undefined) {
      locations = installTimeline(bins, declared, layout, this.context)
      this.timelines.set(key, locations)
    }
    const unknown = (why: string): WriterEvidence => ({ source: "unknown", writes, why, at: Date.now() })
    if (!locations.ok) return unknown(locations.why)
    if (!locations.found.length) return unknown(`no install of ${harness} was found`)
    const found = new Set<string>()
    for (const location of locations.found) {
      const first = location.timeline[0]
      if (!first || first.since > writes.first) return unknown(`${location.where} is known only from ${new Date(first?.since ?? 0).toISOString()}, after the session was first written`)
      const at = (time: number) => location.timeline.filter((entry) => entry.since <= time).at(-1)!.version
      const during = new Set(location.timeline.filter((entry) => entry.since > writes.first && entry.since <= writes.last).map((entry) => entry.version))
      during.add(at(writes.first))
      for (const version of during) found.add(version)
    }
    if (found.size !== 1) return unknown(`installs of ${harness} held ${[...found].join(" and ")} while the session was written`)
    const [version] = found
    return { source: "install", versions: [version!], writes, why: `every install of ${harness} (${locations.found.map((location) => location.where).join(", ")}) was ${version} from before the session's first write to its last`, at: Date.now() }
  }
}

function ordered(versions: Set<string>): string[] {
  return [...versions].sort(compareVersions)
}

/** `cursor-agent`'s build-day version for a time: `2026.10.14`, which every build of that day or earlier sorts below or at. */
export function cursorAgentDay(time: number): string {
  return new Date(time).toISOString().slice(0, 10).replaceAll("-", ".")
}

/** One of Mako's own Cursor SDK agents: the newest SDK Mako's repository had pinned by its last write. */
function makoSdkAgent(path: string): WriterEvidence | null {
  const writes = cursorWrites(path)
  if (!writes) return null
  const pin = pinnedBy(CURSOR_SDK, writes.last)
  if (!pin) return { source: "unknown", writes, why: `Mako's repository pinned no ${CURSOR_SDK} by the agent's last write, ${new Date(writes.last).toISOString()}`, at: Date.now() }
  return {
    source: "range", bound: "pins", upTo: pin.version, writes,
    why: `Mako's repository pinned ${CURSOR_SDK} ${pin.version} in ${pin.commit} (${pin.since}), the newest pin by the agent's last write, ${new Date(writes.last).toISOString()}: the repository's history, not proof of the build that ran`,
    at: Date.now(),
  }
}

const CURSOR_SDK = "@cursor/sdk"
const GROK_NPM = "@xai-official/grok"

/** When a file of a session was first and last written: its birth and its newest change, with its WAL's when that holds anything. */
function fileWrites(path: string): Writes | null {
  const info = statSafe(path)
  if (!info) return null
  const wal = statSafe(`${path}-wal`)
  const last = Math.max(info.mtimeMs, wal && wal.size > 0 ? wal.mtimeMs : 0)
  return { first: Math.min(info.birthtimeMs, info.mtimeMs), last }
}

/** One of Devin.app's launches: when it began (its log folder's name, local time) and the CLI it spawned, null where its log names none or several. */
interface DevinAppLaunch {
  since: number
  binary: string | null
}

const DEVIN_APP_SPAWN = /\[devin-cli\] Spawning process: (\/.+?) acp\b/

/** Each Devin.app launch, oldest first, with the CLI its windows' `Devin ACP.log` say they spawned. */
export function devinAppLaunches(logs: string): DevinAppLaunch[] {
  return readdirSafe(logs).flatMap((name) => {
    const at = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(name)
    if (!at) return []
    const since = new Date(Number(at[1]), Number(at[2]) - 1, Number(at[3]), Number(at[4]), Number(at[5]), Number(at[6])).getTime()
    const spawned = new Set<string>()
    for (const window of readdirSafe(join(logs, name)).filter((each) => each.startsWith("window"))) {
      try {
        const head = readFileSync(join(logs, name, window, "exthost", "codeium.windsurf", "Devin ACP.log"), "utf8").slice(0, 256 * 1024)
        const binary = DEVIN_APP_SPAWN.exec(head)?.[1]
        if (binary) spawned.add(binary)
      } catch {
        // A window that ran no Devin agent keeps no log of it.
      }
    }
    const [binary] = spawned
    return [{ since, binary: spawned.size === 1 && binary ? binary : null }]
  }).sort((a, b) => a.since - b.since)
}

// Each store's write times.

const ComposerTimesSchema = z.object({ created: z.number().nullable(), updated: z.number().nullable() })

function cursorEditorWrites(database: string, id: string): Writes | null {
  if (!existsSync(database)) return null
  const { database: db } = openReadOnly(database, { timeout: 5_000 })
  try {
    const row = ComposerTimesSchema.optional().parse(db.prepare("SELECT json_extract(value, '$.createdAt') AS created, json_extract(value, '$.lastUpdatedAt') AS updated FROM cursorDiskKV WHERE key = ? AND json_valid(value)").get(`composerData:${id}`))
    if (!row?.created) return null
    return { first: row.created, last: Math.max(row.created, row.updated ?? row.created) }
  } finally {
    db.close()
  }
}

/** Each Cursor launch, from its log folder's name (`20260928T222005`, local time) and the version its `main.log` names, oldest first; null where the log names none. */
export function cursorLaunches(logs: string): { since: number; version: string | null }[] {
  return readdirSafe(logs).flatMap((name) => {
    const at = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})$/.exec(name)
    if (!at) return []
    const since = new Date(Number(at[1]), Number(at[2]) - 1, Number(at[3]), Number(at[4]), Number(at[5]), Number(at[6])).getTime()
    let version: string | null = null
    try {
      const head = readFileSync(join(logs, name, "main.log"), "utf8").slice(0, 64 * 1024)
      version = statedVersion(/\/cursor\/(\d+(?:\.\d+)+)\//.exec(head)?.[1])
    } catch {
      version = null
    }
    return [{ since, version }]
  }).sort((a, b) => a.since - b.since)
}

const DevinRowSchema = z.object({ created_at: z.number(), last_activity_at: z.number() })

function devinWrites(database: string, id: string): Writes | null {
  if (!existsSync(database)) return null
  const { database: db } = openReadOnly(database, { timeout: 5_000 })
  try {
    const row = DevinRowSchema.optional().parse(db.prepare("SELECT created_at, last_activity_at FROM sessions WHERE id = ?").get(id))
    // Seconds since the epoch.
    return row ? { first: row.created_at * 1000, last: Math.max(row.created_at, row.last_activity_at) * 1000 } : null
  } finally {
    db.close()
  }
}

const GrokSummarySchema = z.object({ created_at: z.string().optional() }).loose()

function grokWrites(folder: string): Writes | null {
  const times: number[] = []
  for (const name of readdirSafe(folder)) {
    if (name.endsWith(".lock")) continue
    const info = statSafe(join(folder, name))
    if (info?.isFile()) times.push(info.mtimeMs, info.birthtimeMs)
  }
  if (!times.length) return null
  let first = Math.min(...times)
  try {
    const created = GrokSummarySchema.parse(JSON.parse(readFileSync(join(folder, "summary.json"), "utf8"))).created_at
    if (created) first = Math.min(first, Date.parse(created))
  } catch {
    // No summary yet: the files' own times stand.
  }
  return { first, last: Math.max(...times) }
}

const CursorMetaSchema = z.object({ createdAt: z.number().optional() }).loose()

function cursorWrites(path: string): Writes | null {
  const files = [path, `${path}-wal`, join(dirname(path), "meta.json")].flatMap((file) => statSafe(file) ?? [])
  if (!files.length) return null
  let first = Math.min(...files.map((info) => info.birthtimeMs))
  try {
    const { database } = openReadOnly(path, { timeout: 5_000 })
    try {
      const text = z.object({ value: z.union([z.string(), z.instanceof(Uint8Array).transform((bytes) => Buffer.from(bytes).toString("utf8"))]) }).optional().parse(database.prepare("SELECT value FROM meta LIMIT 1").get())?.value ?? ""
      const json = /^[0-9a-f]+$/i.test(text) ? Buffer.from(text, "hex").toString("utf8") : text
      const created = CursorMetaSchema.safeParse(JSON.parse(json || "{}")).data?.createdAt
      if (created) first = Math.min(first, created)
    } finally {
      database.close()
    }
  } catch {
    // A store with no readable meta: the files' times stand.
  }
  return { first, last: Math.max(...files.map((info) => info.mtimeMs)) }
}

function readdirSafe(folder: string): string[] {
  try {
    return readdirSync(folder)
  } catch {
    return []
  }
}

function statSafe(path: string) {
  try {
    return statSync(path)
  } catch {
    return null
  }
}

// Logs.

const DEVIN_VERSION = /\bversion=(\S+) .*\bstartup\b/
const DEVIN_SESSION = /(?:Created new session: |loading session |saved session |for session )([A-Za-z0-9][\w.-]*)/g
const DevinLogCacheSchema = z.record(z.string(), z.object({ size: z.number(), mtimeMs: z.number(), version: z.string().nullable(), sessions: z.array(z.string()) }))
type DevinLogCache = z.infer<typeof DevinLogCacheSchema>

/** Each Devin CLI session its logs name, with the versions of the processes that did. A gzipped log never changes again, so it's read once and kept in `cache`. */
export async function devinLogIndex(folder: string, cache: string | null): Promise<Map<string, Set<string>>> {
  let kept: DevinLogCache = {}
  if (cache) {
    try {
      kept = DevinLogCacheSchema.parse(JSON.parse(await readFile(cache, "utf8")))
    } catch {
      kept = {}
    }
  }
  const next: DevinLogCache = {}
  const index = new Map<string, Set<string>>()
  for (const name of (await readdir(folder).catch(() => [])).sort()) {
    if (!name.endsWith(".log") && !name.endsWith(".log.gz")) continue
    const file = join(folder, name)
    const info = await stat(file).catch(() => null)
    if (!info) continue
    let read = kept[name]?.size === info.size && kept[name]?.mtimeMs === info.mtimeMs ? kept[name] : undefined
    if (!read) {
      const found = await readDevinLog(file).catch(() => null)
      if (!found) continue
      read = { size: info.size, mtimeMs: info.mtimeMs, ...found }
    }
    // Only a finished, gzipped log is kept: a plain one may still be written.
    if (name.endsWith(".gz")) next[name] = read
    if (!read.version) continue
    for (const session of read.sessions) {
      const versions = index.get(session) ?? new Set<string>()
      versions.add(read.version)
      index.set(session, versions)
    }
  }
  if (cache) {
    await mkdir(dirname(cache), { recursive: true }).catch(() => undefined)
    try {
      writeFileSync(cache, JSON.stringify(next))
    } catch {
      // A cache that can't be kept is read again next time.
    }
  }
  return index
}

async function readDevinLog(file: string): Promise<{ version: string | null; sessions: string[] }> {
  const input = createReadStream(file)
  const lines = createInterface({ input: file.endsWith(".gz") ? input.pipe(createGunzip()) : input, crlfDelay: Infinity })
  let version: string | null = null
  const sessions = new Set<string>()
  for await (const line of lines) {
    if (version === null && line.includes("startup")) version = statedVersion(DEVIN_VERSION.exec(line)?.[1]) ?? version
    if (!line.includes("ession")) continue
    for (const match of line.matchAll(DEVIN_SESSION)) if (match[1]) sessions.add(match[1])
  }
  return { version, sessions: [...sessions] }
}

const GROK_LINE = /"pid":(\d+),"ver":"([^"]{1,64})"/
const GROK_SESSION = /"sessionId":"([^"]{1,128})"/

/** Each Grok session its log names, with the versions of the processes that did: every line carries its process and version, and a session's lines its id. */
export async function grokLogIndex(files: readonly string[]): Promise<Map<string, Set<string>>> {
  const index = new Map<string, Set<string>>()
  for (const file of files) {
    if (!existsSync(file)) continue
    const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity })
    for await (const line of lines) {
      const session = GROK_SESSION.exec(line)?.[1]
      if (!session) continue
      const version = statedVersion(GROK_LINE.exec(line)?.[2])
      if (!version) continue
      const versions = index.get(session) ?? new Set<string>()
      versions.add(version)
      index.set(session, versions)
    }
  }
  return index
}

// Installs.

/** One place a harness's CLI is installed, and what it held from when: one entry for a binary replaced in place, one per kept build for a folder of versioned builds. */
export interface InstallLocation {
  where: string
  timeline: { version: string; since: number }[]
}

/** How a harness lays out its own installs, beyond the binaries on PATH. */
interface Layout {
  /** Folders of builds named by version (`grok-1.0.46`, `grok-1.0.4-macos-aarch64`), installed at their mtimes. */
  versioned?: readonly string[]
  /** A folder of one folder per build, named by version, installed at its birth (`cursor-agent`'s `versions/`). */
  versionFolders?: string
  /** The npm package that ships the CLI, whose `package.json` names the version of the binary inside it. */
  npm?: string
}

const ReadingsSchema = z.object({
  signatures: z.record(z.string(), z.object({ binary: z.string(), mtimeMs: z.number(), size: z.number(), installed: z.string().optional() }).loose()).optional(),
}).loose()

/** Where a CLI may be run from: `PATH`, the context's folders, and the folders installers put CLIs in. */
function candidateFolders(context: EvidenceContext): string[] {
  const home = context.home
  const nvm = join(home, ".nvm", "versions", "node")
  const nodes = readdirSafe(nvm).map((version) => join(nvm, version, "bin"))
  if (context.path) return [...context.path]
  return [...new Set([...(process.env.PATH ?? "").split(delimiter), join(home, ".local", "bin"), join(home, ".bun", "bin"), join(home, ".npm-global", "bin"), "/opt/homebrew/bin", "/usr/local/bin", ...nodes].filter(Boolean))]
}

/**
 * Every install of a harness this can find, each with what it held from
 * when, or why that can't be known: a binary whose version neither its
 * folder, its npm package nor the host's reading of it says means installs
 * can't be told apart, so none is trusted.
 */
/** Every install found, or why installs can't be told apart. */
export type InstallTimeline = { ok: true; found: InstallLocation[] } | { ok: false; why: string }

export function installTimeline(bins: readonly string[], declared: readonly (string | null)[], layout: Layout | null, context: EvidenceContext): InstallTimeline {
  const locations = new Map<string, InstallLocation>()
  let readings: z.infer<typeof ReadingsSchema> = {}
  try {
    if (context.readings) readings = ReadingsSchema.parse(JSON.parse(readFileSync(context.readings, "utf8")))
  } catch {
    readings = {}
  }
  const owned = (real: string): string | null => {
    for (const folder of layout?.versioned ?? []) if (real.startsWith(folder + sep)) return folder
    if (layout?.versionFolders && real.startsWith(layout.versionFolders + sep)) return layout.versionFolders
    return null
  }
  for (const folder of layout?.versioned ?? []) {
    const timeline = readdirSafe(folder).flatMap((name) => {
      const version = statedVersion(/^[a-z-]+?-(\d+(?:\.\d+)+)(?:-[a-z]+-[a-z0-9_]+)?$/i.exec(name)?.[1])
      const info = statSafe(join(folder, name))
      return version && info?.isFile() ? [{ version, since: info.mtimeMs }] : []
    })
    if (timeline.length) locations.set(folder, { where: folder, timeline: timeline.sort((a, b) => a.since - b.since) })
  }
  if (layout?.versionFolders) {
    const timeline = readdirSafe(layout.versionFolders).flatMap((name) => {
      const info = statSafe(join(layout.versionFolders!, name))
      const version = statedVersion(name)
      return version && info?.isDirectory() ? [{ version, since: info.birthtimeMs }] : []
    })
    if (timeline.length) locations.set(layout.versionFolders, { where: layout.versionFolders, timeline: timeline.sort((a, b) => a.since - b.since) })
  }
  const binaries = [...declared.filter((path): path is string => Boolean(path)), ...candidateFolders(context).flatMap((folder) => bins.map((bin) => join(folder, bin)))]
  for (const binary of binaries) {
    let real: string
    try {
      real = realpathSync(binary)
    } catch {
      continue
    }
    const info = statSafe(real)
    if (!info?.isFile() || locations.has(real)) continue
    const folder = owned(real)
    if (folder) {
      if (!locations.has(folder)) return { ok: false, why: `${binary} is in ${folder}, which holds no build this can name` }
      continue
    }
    const version = npmVersion(real, layout?.npm) ?? readingVersion(readings, real, info)
    if (!version) return { ok: false, why: `the version of ${binary} (${real}) isn't known from its folder, its package or Mako's reading of it` }
    locations.set(real, { where: real, timeline: [{ version, since: info.mtimeMs }] })
  }
  return { ok: true, found: [...locations.values()] }
}

const PackageSchema = z.object({ name: z.string(), version: z.string() })

/** The version of the npm package `name` a binary sits in, from its `package.json`. */
function npmVersion(real: string, name: string | undefined): string | null {
  if (!name) return null
  let folder = dirname(real)
  for (let depth = 0; depth < 4; depth++) {
    try {
      const parsed = PackageSchema.parse(JSON.parse(readFileSync(join(folder, "package.json"), "utf8")))
      if (parsed.name === name) return statedVersion(parsed.version)
    } catch {
      // No package here: one folder up.
    }
    folder = dirname(folder)
  }
  return null
}

/** The version the host read off this binary, while it's the same file. */
function readingVersion(readings: z.infer<typeof ReadingsSchema>, real: string, info: { mtimeMs: number; size: number }): string | null {
  for (const signature of Object.values(readings.signatures ?? {})) {
    let signed: string
    try {
      signed = realpathSync(signature.binary)
    } catch {
      continue
    }
    if (signed === real && signature.mtimeMs === info.mtimeMs && signature.size === info.size && signature.installed) return statedVersion(signature.installed)
  }
  return null
}

/** Devin.app's bundled CLI, where Devin's installer puts it. */
const DEVIN_APP_CLI = "/Applications/Devin.app/Contents/Resources/app/extensions/windsurf/devin/bin/devin"
