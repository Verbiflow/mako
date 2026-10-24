import { existsSync, statSync, type Stats } from "node:fs"
import { z } from "zod"
import { compactionEvent, type Compaction, type TranscriptEvent } from "../events.js"
import type { ProposedPlan } from "../content.js"
import { codexPrompt } from "./codex-presentation.js"
import { CodexCarrySchema, CodexRecords, latestCodexSettings, parseCodexRolloutLine, type CodexRead } from "./codex-records.js"
import type { LiveUpdate } from "../live-content.js"
import type { SessionSettings } from "../settings.js"

/**
 * Codex CLI sessions, read through the one decoder of Codex's rollout
 * records (`codex-records.ts`) that live sessions run too; this file finds
 * rollouts, reads their identity and folds what the decoder reads into
 * entries.
 *
 * Native store: `~/.codex/sessions/YYYY/MM/DD/rollout-<stamp>-<uuid>.jsonl`.
 */

import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { ownedRows, type RecordPlace, type RecordRoot, type SessionRecords } from "../harness-records.js"
import type { ChildTranscript } from "../children.js"
import { CodexChildren } from "./codex-children.js"
import { stat, rm } from "node:fs/promises"
import type { SQLOutputValue } from "node:sqlite"
import type { NativeStores } from "../read-only-sqlite.js"
import { titleFrom, type DecodedBlock, type Thread, type DecodedEntry, type ThreadRef, type ThreadTail, type TurnUsage } from "../format.js"
import {
  createJsonlFollower,
  decodeFrom,
  decodeRecord,
  lineRecord,
  readLines,
  type RecordTranslator,
  type FollowStart,
  type ResumePoint,
} from "../jsonl.js"
import { PlainSizes, recordEncoding, statRecord } from "../record-files.js"
import { fieldScan, statedVersion, type RecordWriterRule } from "../record-writers.js"
import type { NativeFile, SessionProvider } from "./types.js"
import { followCurrentCwd } from "./current-cwd.js"
import { CodexRollouts, namedRollout, rolloutThread } from "./codex-rollouts.js"
import { EntrySink, type TurnState } from "../entry-sink.js"
import type { Entry } from "../entries.js"
import { codexFork } from "./codex-fork.js"

interface CodexThreadMetadata {
  rolloutPath?: string
  title?: string
  cwd?: string
  updatedAt?: string
}

interface CodexPeekResult {
  ref: ThreadRef | null
}

type AssistantEntry = Extract<DecodedEntry, { kind: "assistant" }>
type ToolBlock = DecodedBlock & { type: "tool" }

/**
 * Where a code cell ended (`CodexRead` `mark`): after `index` blocks of
 * `entry`, where calls the cell started that Codex writes later are drawn,
 * those placed there ordered by when they started (`started`). `order` is
 * the mark's place among marks at the same spot: an earlier cell's calls
 * go before a later one's.
 */
interface CellMark {
  entry: AssistantEntry
  index: number
  started: number[]
  order: number
}

/** The most cell marks a translator keeps for calls written after their cell. */
const MAX_MARKS = 4096

interface CodexTranslator extends RecordTranslator {
  readonly needsReset: boolean
}

function sqliteText(value: SQLOutputValue | undefined): string | undefined {
  return Object.prototype.toString.call(value) === "[object String]"
    ? String(value)
    : undefined
}

function sqliteNumber(value: SQLOutputValue | undefined): number | undefined {
  if (Object.prototype.toString.call(value) !== "[object Number]")
    return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

const FILED_ROLLOUT = /^(.*?)(?:sessions\/\d{4}\/\d{2}\/\d{2}|archived_sessions)\/(rollout-(\d{4})-(\d{2})-(\d{2})T[^/]+\.jsonl)$/

/** A rollout is one record wherever Codex files it: under its date while open, in `archived_sessions` once archived. */
export function codexRecordPlace(path: string): RecordPlace | null {
  const filed = FILED_ROLLOUT.exec(path)
  if (!filed) return null
  const [, root = "", name = "", year = "", month = "", day = ""] = filed
  return { key: `${root}rollouts/${name}`, places: [`${root}sessions/${year}/${month}/${day}/${name}`, `${root}archived_sessions/${name}`] }
}

/**
 * Codex states the version that started a rollout in its `session_meta`
 * (`cli_version`), and the version that last wrote a thread in its
 * `threads` row; a turn's own lines state none, so a rollout a newer Codex
 * resumed shows that version only in the row.
 */
const CODEX_WRITER: RecordWriterRule = {
  file: (key) => (key.includes(":rollouts/") ? codexVersions() : null),
  row: (table, row) => (table === "threads" ? statedVersion(row.cli_version) : null),
}
const codexVersions = fieldScan('"cli_version":"', /"cli_version":"([^"]{1,64})"/, { before: 0, after: 80 })

export class CodexProvider implements SessionProvider {
  /** Where its records state the build that wrote them. */
  readonly recordWriter = CODEX_WRITER
  harness = "codex" as const
  /** 1: the service tier is read from `thread_settings_applied`. 2: rows carry `currentCwd` from the latest `turn_context`. 3: archived rows carry `nativeArchiveStamp`. 4: that stamp is the rollout's mtime. 5: archived rows carry `resumeUnavailable`. */
  peekVersion = 5
  displayName = "Codex"
  /** How a session is written again as its own fork (`codex-fork.ts`). */
  readonly fork = codexFork
  private root: string
  /**
   * Where Codex's archive moves a rollout, filename kept and date folders
   * flattened; unarchiving moves it back. The row follows it both ways.
   */
  private archivedRoot: string
  /**
   * Codex appends a thread's name here whenever it names or renames one, and
   * only then; the name itself lands in the state database, which every turn
   * rewrites, and the rollout is untouched.
   */
  private nameLog: string
  private metadataPath: string
  private metadataMtime = -1
  private namesRead: { stamp: string; names: Promise<Map<string, string>> } | undefined
  private metadata = new Map<string, CodexThreadMetadata>()
  private metadataKnown = new Set<string>()
  private metadataLoads = new Map<
    string,
    Promise<CodexThreadMetadata | undefined>
  >()

  private readonly stores: NativeStores
  private readonly plainSizes = new PlainSizes()
  private readonly rolloutFiles: CodexRollouts
  private spawned: CodexChildren | undefined

  constructor(stores: NativeStores, home = homedir()) {
    this.stores = stores
    this.root = join(home, ".codex", "sessions")
    this.archivedRoot = join(home, ".codex", "archived_sessions")
    this.nameLog = join(home, ".codex", "session_index.jsonl")
    this.metadataPath = join(home, ".codex", "state_5.sqlite")
    this.rolloutFiles = new CodexRollouts([this.root, this.archivedRoot])
  }

  /**
   * The model and effort Codex's state database keeps for a thread, which a
   * compressed rollout's settings come from: its tail can't be read without
   * decoding the whole file.
   */
  private storedSettings(id: string): SessionSettings | undefined {
    try {
      const database = this.stores.open(this.metadataPath)
      try {
        const row = database.prepare("SELECT model, reasoning_effort FROM threads WHERE id = ?").get(id)
        const model = sqliteText(row?.model)
        const effort = sqliteText(row?.reasoning_effort)
        if (!model && !effort) return undefined
        return { ...model && { model }, ...effort && { options: { effort } } }
      } finally {
        database.close()
      }
    } catch {
      // An older database without these columns keeps no settings to read.
      return undefined
    }
  }

  rescanRoot = (path: string): boolean => path === this.nameLog

  private async threadMetadata(
    id: string
  ): Promise<CodexThreadMetadata | undefined> {
    const [info, wal] = await Promise.all([
      stat(this.metadataPath).catch(() => null),
      stat(`${this.metadataPath}-wal`).catch(() => null),
    ])
    if (!info) return undefined
    const mtime = Math.max(info.mtimeMs, wal?.mtimeMs ?? 0)
    if (mtime !== this.metadataMtime) {
      this.metadata.clear()
      this.metadataKnown.clear()
      this.metadataLoads.clear()
      this.metadataMtime = mtime
    }
    if (this.metadataKnown.has(id)) return this.metadata.get(id)
    const existing = this.metadataLoads.get(id)
    if (existing) return existing
    const load = (async () => {
      const database = this.stores.open(this.metadataPath)
      try {
        const row = database
          .prepare(
            "SELECT id, name, title, cwd, updated_at_ms, rollout_path FROM threads WHERE id = ? AND (thread_source IS NULL OR thread_source != 'subagent')"
          )
          .get(id)
        if (this.metadataMtime !== mtime) return this.metadata.get(id)
        this.metadataKnown.add(id)
        if (!row) return undefined
        const updatedAtMs = sqliteNumber(row.updated_at_ms)
        const storedTitle = sqliteText(row.title)
        const conciseTitle =
          storedTitle && !storedTitle.includes("\n") && storedTitle.length <= 80
            ? titleFrom(storedTitle)
            : undefined
        const metadata = {
          rolloutPath: sqliteText(row.rollout_path),
          title: titleFrom(sqliteText(row.name)) ?? conciseTitle,
          cwd: sqliteText(row.cwd),
          updatedAt: updatedAtMs
            ? new Date(updatedAtMs).toISOString()
            : undefined,
        }
        this.metadata.set(id, metadata)
        return metadata
      } catch {
        return undefined
      } finally {
        database.close()
      }
    })().finally(() => {
      if (this.metadataLoads.get(id) === load) this.metadataLoads.delete(id)
    })
    this.metadataLoads.set(id, load)
    return load
  }

  roots(): string[] {
    return [this.root, this.archivedRoot, this.nameLog]
  }

  watchRoots(): string[] {
    return [this.root, this.archivedRoot]
  }

  pollFiles(): string[] {
    return [this.nameLog]
  }

  /**
   * Each named thread's name, so a rename re-reads a rollout it didn't touch.
   * Read again only once the name log or the state database changes.
   */
  private names(): Promise<Map<string, string>> {
    const stamp = [this.nameLog, this.metadataPath, `${this.metadataPath}-wal`]
      .map((path) => {
        const info = statSync(path, { throwIfNoEntry: false })
        return info ? `${info.size}:${info.mtimeMs}` : "-"
      })
      .join(" ")
    if (this.namesRead?.stamp !== stamp) this.namesRead = { stamp, names: this.readNames() }
    return this.namesRead.names
  }

  private async readNames(): Promise<Map<string, string>> {
    const names = new Map<string, string>()
    if (!existsSync(this.metadataPath)) return names
    try {
      const database = this.stores.open(this.metadataPath)
      try {
        for (const row of database.prepare("SELECT id, name FROM threads WHERE name IS NOT NULL AND name != ''").all()) {
          const id = sqliteText(row.id)
          const name = sqliteText(row.name)
          if (id && name) names.set(id, name)
        }
      } finally {
        database.close()
      }
    } catch {
      // Unnamed is the safe reading: the rollout's own stat still decides.
    }
    return names
  }

  observationPaths(path: string): string[] {
    return [path, this.metadataPath, `${this.metadataPath}-wal`]
  }

  /**
   * A rollout's stat facts, sized in plain bytes whatever its encoding; the
   * revision carries its thread's name, which a rename changes without
   * touching the rollout.
   */
  private async nativeFile(path: string, info: Stats, names: ReadonlyMap<string, string>): Promise<NativeFile | null> {
    const record = await statRecord(path, info, this.plainSizes).catch(() => null)
    if (!record) return null
    const file: NativeFile = { path, bytes: record.bytes, mtimeMs: record.mtimeMs }
    const name = names.get(rolloutThread(path) ?? path)
    return name === undefined ? file : { ...file, revision: `name:${name}` }
  }

  async stat(path: string): Promise<NativeFile | null> {
    const info = await stat(path).catch(() => null)
    return info?.isFile() ? this.nativeFile(path, info, await this.names()) : null
  }

  async discover(): Promise<NativeFile[]> {
    const [paths, names] = await Promise.all([this.rolloutFiles.list(0), this.names()])
    const byIdentity = new Map<string, NativeFile[]>()
    for (let index = 0; index < paths.length; index += 8) {
      const batch = await Promise.all(
        paths.slice(index, index + 8).map(async (path) => {
          const info = await stat(path).catch(() => null)
          return info?.isFile() ? this.nativeFile(path, info, names) : null
        })
      )
      for (const file of batch) {
        if (!file) continue
        // A reverted thread continues in `<id>_<rollout>.jsonl` with the same
        // thread id; the first id names the thread and the group below picks
        // Codex's current file for it.
        const id = rolloutThread(file.path) ?? file.path
        const group = byIdentity.get(id) ?? []
        group.push(file)
        byIdentity.set(id, group)
      }
    }
    const groups = [...byIdentity]
    const files: NativeFile[] = []
    for (let index = 0; index < groups.length; index += 8) {
      const batch = await Promise.all(
        groups.slice(index, index + 8).map(async ([id, candidates]) => {
          // An undo starts a thread's next rollout. The path Codex names is authoritative;
          // display timestamps are shared across a thread's rollouts and cannot choose one.
          const current =
            candidates.length > 1
              ? namedRollout(candidates.map((file) => file.path), (await this.threadMetadata(id))?.rolloutPath)
              : undefined
          return (
            candidates.find((file) => file.path === current) ??
            candidates.sort((a, b) => b.mtimeMs - a.mtimeMs)[0]
          )
        })
      )
      for (const file of batch) if (file) files.push(file)
    }
    return files
  }

  async peek(file: NativeFile): Promise<ThreadRef | null> {
    const budget = 8 * 1024 * 1024
    let spent = 0
    let sawMeta = false
    const found: CodexPeekResult = { ref: null }
    await readLines(file.path, 0, (raw) => {
      spent += raw.length + 1
      const event = parseCodexRolloutLine(raw)
      if (!event) return spent < budget
      if (event.kind === "session_meta") {
        if (sawMeta) return spent < budget
        sawMeta = true
        if (!event.id || event.threadSource === "subagent") return false
        found.ref = {
          harness: this.harness,
          nativeId: event.id,
          path: file.path,
          cwd: event.cwd,
          startedAt: event.startedAt ?? event.at,
          updatedAt: new Date(file.mtimeMs).toISOString(),
          bytes: file.bytes,
        }
        if (event.forkedFrom && event.forkedFrom !== event.id) found.ref.parentNativeId = event.forkedFrom
        return spent < budget
      }
      if (!sawMeta) return false // Not a rollout file at all.
      const ref = found.ref
      if (!ref) return spent < budget
      if (event.kind === "turn_context" && !ref.model && event.model) {
        ref.model = event.model
      }
      if (
        !ref.title &&
        (event.kind === "user_message_event" || event.kind === "user_response")
      ) {
        ref.title = titleFrom(codexPrompt(event.text))
      }
      return spent < budget && !(ref.title && ref.model)
    })
    const ref = found.ref
    if (!ref) return null
    // Head metadata identifies the thread. Only the bounded tail describes its latest settings.
    ref.settings = {}
    let turnCwd: string | undefined
    if (recordEncoding(file.path) === "plain") {
      await readLines(
        file.path,
        Math.max(0, file.bytes - 2 * 1024 * 1024),
        (raw) => {
          // Only a turn's settings matter here; a tool's output is never parsed for them.
          if (!raw.includes('"turn_context"') && !raw.includes('"thread_settings_applied"')) return
          const event = parseCodexRolloutLine(raw)
          if (event?.kind === "turn_context") {
            ref.settings = latestCodexSettings(ref.settings, event.settings)
            if (event.model) ref.model = event.model
            turnCwd = event.cwd ?? turnCwd
          }
        }
      )
    } else {
      // A compressed rollout's tail costs decoding all of it; Codex keeps the
      // latest model and effort beside it, and restores the file before a turn.
      const stored = this.storedSettings(ref.nativeId)
      if (stored) {
        ref.settings = latestCodexSettings(ref.settings, stored)
        if (stored.model) ref.model = stored.model
      }
    }
    const details = await this.threadMetadata(ref.nativeId)
    const next: ThreadRef = details
      ? {
          ...ref,
          cwd: details.cwd ?? ref.cwd,
          title: details.title ?? ref.title,
          updatedAt:
            details.updatedAt && details.updatedAt > (ref.updatedAt ?? "")
              ? details.updatedAt
              : ref.updatedAt,
        }
      : ref
    followCurrentCwd(next, turnCwd)
    if (file.path.startsWith(`${this.archivedRoot}/`)) {
      next.nativeArchived = true
      // Unarchiving sets the rollout's mtime and archiving keeps it, so each
      // archive has its own; `migrate-rollouts` rewrites the file but keeps it.
      next.nativeArchiveStamp = String(Math.floor(file.mtimeMs))
      // Codex resumes an archived thread only once unarchived, and whether it
      // is archived is Codex's to decide.
      next.resumeUnavailable =
        "Codex keeps archived chats closed, so this one continues here in a new Codex session. It stays archived in Codex."
    }
    return next
  }

  /**
   * The rollout, and the thread's rows in the databases beside it: its name
   * and tools in the state database, its goals, its queued prompts. The
   * turn history database is left: Codex projects it from the rollout again,
   * from the offset it records there. The agents it spawned and its reviews
   * come with it, their rollouts and rows alike: a child is never a row of
   * its own, so nothing else would keep it.
   */
  /** `codex`: Codex's home, where its sessions, state and logs are. */
  recordRoots(): RecordRoot[] {
    return [{ name: "codex", path: dirname(this.metadataPath) }]
  }

  async records(path: string): Promise<SessionRecords | null> {
    if (!this.rolloutFiles.holds(path)) return null
    if (!(await stat(path).catch(() => null))?.isFile()) return null
    const id = rolloutThread(path)
    if (!id) return null
    const codexHome = dirname(this.metadataPath)
    // Its spawned agents are threads of their own, kept with it; the rollouts
    // its history continues are read with it, so they come too.
    const [spawned, own, lineage] = await Promise.all([
      this.childLinks().rolloutsOf(path),
      this.rolloutFiles.filesOf(id),
      this.rolloutFiles.lineage(path),
    ])
    const ids = [id, ...spawned.ids]
    const listed = ids.map(() => "?").join(", ")
    const state = ownedRows(this.metadataPath, ids, {
      owner: "thread_id",
      keyed: { threads: "id" },
      shared: ["_sqlx_migrations"],
      extra: [{ table: "thread_spawn_edges", where: `parent_thread_id IN (${listed}) OR child_thread_id IN (${listed})`, params: [...ids, ...ids] }],
    })
    const databases = [
      state && { ...state, tables: state.tables.map((table) => (table.table === "threads" ? { ...table, paths: ["rollout_path"] } : table)) },
      ownedRows(join(codexHome, "goals_1.sqlite"), ids, { owner: "thread_id", shared: ["_sqlx_migrations"] }),
      ownedRows(join(codexHome, "queue_1.sqlite"), ids, { owner: "thread_id", shared: ["_sqlx_migrations"] }),
    ]
    const files = new Set([path, ...own, ...lineage.spans.map((span) => span.path), ...spawned.files])
    return {
      roots: this.recordRoots(),
      files: [...files],
      databases: databases.filter((database) => database !== null),
      lines: ids.map((value) => ({ path: this.nameLog, field: "id", value })),
      place: codexRecordPlace,
      writer: CODEX_WRITER,
      children: spawned.children,
    }
  }

  /** Its rollouts are listed again: a restore wrote some (`SessionProvider.storeWritten`). */
  storeWritten(): void {
    this.rolloutFiles.forget()
  }

  /** Its spawned agents, from the state database's spawn edges and its own rollout's items, and its reviews. */
  async children(path: string): Promise<ChildTranscript[] | null> {
    if (!this.rolloutFiles.holds(path)) return null
    return this.childLinks().list(path)
  }

  private childLinks(): CodexChildren {
    return (this.spawned ??= new CodexChildren({ stores: this.stores, rollouts: this.rolloutFiles, metadataPath: this.metadataPath }))
  }

  /**
   * Removes the thread's rollouts in every encoding, archived or not, and its
   * row. Refused while another thread's history continues from one of them,
   * as Codex refuses it: that thread would lose its start.
   */
  async remove(path: string): Promise<boolean> {
    if (!this.rolloutFiles.holds(path)) return false
    const id = rolloutThread(path)
    if (!id) return false
    this.stores.refuseWrite("Codex's sessions")
    const continuing = (await this.rolloutFiles.continuedBy(new Set([id]))).get(id)
    if (continuing) throw new Error(`Codex thread ${id} can't be removed: thread ${continuing} continues its history`)
    const files = await this.rolloutFiles.filesOf(id)
    for (const file of files) await rm(file, { force: true })
    if (existsSync(this.metadataPath)) {
      const database = this.stores.openForWriting(this.metadataPath)
      try {
        database.prepare("DELETE FROM threads WHERE id = ?").run(id)
      } finally {
        database.close()
      }
    }
    this.metadata.delete(id)
    this.metadataKnown.delete(id)
    return true
  }

  /**
   * Codex names a thread in its state database after the first turn; pick
   * that up without rereading the rollout. Only the appended bytes are read,
   * for a turn that ran in another folder.
   */
  async refine(ref: ThreadRef, fromByte: number): Promise<ThreadRef> {
    let turnCwd: string | undefined
    await readLines(ref.path, fromByte, (raw) => {
      if (!raw.includes('"turn_context"')) return
      const event = parseCodexRolloutLine(raw)
      if (event?.kind === "turn_context") turnCwd = event.cwd ?? turnCwd
    })
    const details = await this.threadMetadata(ref.nativeId)
    const next: ThreadRef = details
      ? {
          ...ref,
          cwd: details.cwd ?? ref.cwd,
          title: details.title ?? ref.title,
          updatedAt:
            details.updatedAt && details.updatedAt > (ref.updatedAt ?? "")
              ? details.updatedAt
              : ref.updatedAt,
        }
      : { ...ref }
    followCurrentCwd(next, turnCwd)
    return next
  }

  /** The thread across its lineage: the rollouts it continues, then its own. */
  async read(path: string): Promise<Thread | null> {
    const file = await statRecord(path).catch(() => null)
    if (!file) return null
    const native: NativeFile = { path, bytes: file.bytes, mtimeMs: file.mtimeMs }
    const ref = (await this.peek(native)) ?? (await this.childLinks().ref(path, file.bytes, file.mtimeMs))
    if (!ref) return null
    const lineage = await this.rolloutFiles.lineage(path)
    const decode = await decodeRecord(lineage.spans, translator())
    const thread: Thread = { ref, checkpoint: decode.checkpoint, entries: decode.entries }
    if (lineage.missing) {
      thread.entries.unshift({
        type: "event",
        id: "mako:earlier-history",
        label: "Earlier history missing",
        detail: `This thread continues Codex rollout ${lineage.missing}, which this machine no longer keeps; it shows from where that rollout ended`,
      })
      if (decode.resume) decode.resume.entry++
    }
    if (decode.unread) thread.unread = decode.unread
    if (decode.resume) thread.resume = decode.resume
    return thread
  }

  async readFrom(path: string, from: ResumePoint, after: string | undefined): Promise<ThreadTail | null> {
    const file = await statRecord(path).catch(() => null)
    if (!file) return null
    const ref = (await this.peek({ path, bytes: file.bytes, mtimeMs: file.mtimeMs })) ?? (await this.childLinks().ref(path, file.bytes, file.mtimeMs))
    const decode = ref && (await decodeFrom(path, from, translator(after, from.state)))
    return decode && { ref, ...decode }
  }

  createFollower(path: string, fromByte: number, start?: FollowStart) {
    return createJsonlFollower(path, fromByte, translator, async () => (await this.rolloutFiles.lineage(path)).spans, start)
  }

  async tail(
    path: string,
    fromByte: number
  ): Promise<{ entries: Entry[]; nextByte: number }> {
    const into = translator()
    const nextByte = await readLines(path, fromByte, into.push)
    return { entries: into.done(), nextByte }
  }
}

/** A decoded call as a saved tool block, clipped as every store keeps it. */
function toolBlock(update: Extract<LiveUpdate, { kind: "tool" | "tool-update" }>, name: string): ToolBlock {
  const block: ToolBlock = { type: "tool", id: update.id, name, input: update.input }
  if (update.output !== undefined) block.output = update.output
  if (update.status === "failed") block.error = true
  if (update.status === "canceled") block.canceled = true
  if (update.details) block.details = update.details
  if (update.attachments?.length) block.attachments = update.attachments
  if (update.effects?.length) block.effects = update.effects
  return block
}

/**
 * The decoder's reads as canonical entries, one line at a time: each prompt
 * its own entry, each reply's content in the entry of the model message it
 * came with, markers between. A call keeps its place when its output or
 * item arrives later. Push-based so a gigabyte session streams through
 * without ever being held.
 */
/** What a rollout's translator knew at a turn's start (`TurnPoint.state`). */
const CodexTurnStateSchema = z.object({ records: CodexCarrySchema, model: z.string().optional() })

/**
 * A rollout's translator; one begun at a `ResumePoint` takes the id of the
 * entry before it (`after`) and what the translator knew there (`state`).
 */
function translator(after?: string, state?: TurnState): CodexTranslator {
  const sink = new EntrySink(after)
  const carried = state === undefined ? undefined : CodexTurnStateSchema.safeParse(state).data
  const records = new CodexRecords(carried?.records)
  let assistant: AssistantEntry | null = null
  let needsReset = state !== undefined && !carried
  let model: string | undefined = carried?.model
  /** `sink.position` as each turn this translator saw began, which a rollback returns to. */
  const turnStarts: number[] = []
  /** Each call's entry and where its block sits in it, which a later record can still change. */
  const tools = new Map<string, { entry: AssistantEntry; index: number; name: string }>()
  const plans = new Map<string, { card: ProposedPlan; entry: AssistantEntry }>()
  /** The latest compaction's marker and what it counts, which Codex names a few records on. */
  let compaction: { entry: Extract<DecodedEntry, { kind: "event" }>; counted: Compaction } | undefined
  /** Where each code cell ended, by its call's id, and the marks in each entry. */
  const marks = new Map<string, CellMark>()
  const entryMarks = new WeakMap<AssistantEntry, CellMark[]>()
  let markOrder = 0

  const openAssistant = (at?: string): AssistantEntry => {
    if (!assistant) {
      assistant = { kind: "assistant", at, model, blocks: [] }
      sink.push(assistant)
    }
    return assistant
  }
  const place = (at: string | undefined, block: DecodedBlock): AssistantEntry => {
    const entry = openAssistant(at)
    entry.blocks.push(block)
    return entry
  }
  const pushMarker = (marker: TranscriptEvent, at: string | undefined): Extract<DecodedEntry, { kind: "event" }> => {
    assistant = null
    const entry: Extract<DecodedEntry, { kind: "event" }> = at ? { kind: "event", at, ...marker } : { kind: "event", ...marker }
    sink.push(entry)
    return entry
  }

  const content = (update: LiveUpdate, at: string | undefined): void => {
    switch (update.kind) {
      case "user":
        assistant = null
        sink.push({ kind: "user", id: update.messageId, at, ...update.steeringFor && { steeringFor: update.steeringFor }, text: update.text, attachments: update.attachments ?? [] })
        return
      case "provider-turn": {
        assistant = null
        const entry: Extract<DecodedEntry, { kind: "event" }> = { kind: "event", label: update.reason, ...update.cause && { cause: update.cause }, ...update.body && { body: update.body }, opensTurn: true }
        if (update.source) {
          entry.id = update.source.record
          entry.source = update.source
        }
        if (at) entry.at = at
        sink.push(entry)
        return
      }
      case "text":
        if (update.id && assistant?.id !== update.id) assistant = null
        openAssistant(at).id = update.id
        openAssistant(at).blocks.push({ type: "text", text: update.text })
        return
      case "thinking":
        place(at, { type: "thinking", text: update.text })
        return
      case "attachment":
        place(at, update.attachment)
        return
      case "tool": {
        const name = update.name ?? update.title
        const entry = place(at, toolBlock(update, name))
        tools.set(update.id, { entry, index: entry.blocks.length - 1, name })
        return
      }
      case "tool-update": {
        const placed = tools.get(update.id)
        if (!placed) {
          needsReset = true
          return
        }
        placed.entry.blocks[placed.index] = toolBlock(update, placed.name)
        sink.edited(placed.entry)
        return
      }
      case "proposed-plan": {
        const placed = plans.get(update.id)
        if (placed) {
          delete placed.card.truncated
          Object.assign(placed.card, { text: update.text, status: "proposed" }, update.truncated && { truncated: true })
          sink.edited(placed.entry)
          return
        }
        const card: ProposedPlan = { type: "proposed-plan", id: update.id, text: update.text, status: "proposed", ...update.truncated && { truncated: true } }
        plans.set(update.id, { card, entry: place(at, card) })
        return
      }
      default:
        return
    }
  }

  /** A cell ended: where the content drawn so far ends, in the reply being written or, between replies, in one of its own. */
  const mark = (id: string, at: string | undefined): void => {
    let entry = assistant
    if (!entry) {
      entry = { kind: "assistant", at, model, blocks: [] }
      sink.push(entry)
    }
    const cell: CellMark = { entry, index: entry.blocks.length, started: [], order: markOrder++ }
    marks.delete(id)
    marks.set(id, cell)
    if (marks.size > MAX_MARKS) marks.delete(marks.keys().next().value!)
    const inEntry = entryMarks.get(entry)
    if (inEntry) inEntry.push(cell)
    else entryMarks.set(entry, [cell])
  }

  /** A call drawn back at its cell's mark, after the calls placed there that started before it. */
  const placeAt = (cell: CellMark, started: number, update: Extract<LiveUpdate, { kind: "tool" }>): void => {
    let after = 0
    while (after < cell.started.length && cell.started[after]! <= started) after++
    const { entry } = cell
    const index = cell.index + after
    const name = update.name ?? update.title
    entry.blocks.splice(index, 0, toolBlock(update, name))
    cell.started.splice(after, 0, started)
    for (let at = index + 1; at < entry.blocks.length; at++) {
      const block = entry.blocks[at]!
      const placed = block.type === "tool" && block.id !== undefined ? tools.get(block.id) : undefined
      if (placed?.entry === entry && placed.index === at - 1) placed.index = at
    }
    for (const other of entryMarks.get(entry) ?? [])
      if (other !== cell && (other.index > index || (other.index === index && other.order > cell.order))) other.index++
    tools.set(update.id, { entry, index, name })
    sink.inserted(entry, index)
  }

  const apply = (read: CodexRead): void => {
    switch (read.kind) {
      case "update": {
        const { place } = read
        const cell = place && marks.get(place.mark)
        if (place && cell && read.update.kind === "tool") placeAt(cell, place.started, read.update)
        else content(read.update, read.at)
        return
      }
      case "mark":
        mark(read.mark, read.at)
        return
      case "turn":
        if (read.started) {
          turnStarts.push(sink.position)
          if (read.carry) sink.turn({ records: read.carry, ...model !== undefined && { model } })
        }
        return
      case "settings":
        if (read.model) model = read.model
        return
      case "usage": {
        // One entry can hold several calls' work, a tool call and the reply after it; it carries what they all spent.
        if (!assistant) return
        const before = assistant.usage
        const usage: TurnUsage = {
          input: (before?.input ?? 0) + read.usage.input,
          output: (before?.output ?? 0) + read.usage.output,
          cacheRead: (before?.cacheRead ?? 0) + read.usage.cacheRead,
          cacheWrite: (before?.cacheWrite ?? 0) + read.usage.cacheWrite,
        }
        assistant.usage = usage
        sink.edited(assistant)
        return
      }
      case "marker":
        pushMarker(read.marker, read.at)
        return
      case "compacted":
        compaction = { entry: pushMarker(compactionEvent(read.compaction), read.at), counted: read.compaction }
        return
      case "compaction-named": {
        if (!compaction) {
          needsReset = true
          return
        }
        if (read.tokensAfter !== undefined) {
          compaction.counted = { ...compaction.counted, tokensAfter: read.tokensAfter }
          Object.assign(compaction.entry, compactionEvent(compaction.counted))
        }
        if (read.source) compaction.entry.source = { harness: "codex", record: read.source }
        sink.edited(compaction.entry)
        return
      }
      case "rolled-back":
        // Codex drops the latest turns whole, as its own history does.
        if (read.turns > turnStarts.length) needsReset = true
        sink.rewind(turnStarts.length > read.turns ? turnStarts[turnStarts.length - read.turns]! : (turnStarts[0] ?? sink.position))
        turnStarts.length = Math.max(0, turnStarts.length - read.turns)
        assistant = null
        return
      case "unread":
        sink.unread(read.type, read.reason, read.record)
        return
      case "unplaced":
        needsReset = true
        return
    }
  }

  return {
    push: (raw, place) => {
      sink.reading(lineRecord(place))
      for (const read of records.line(raw, place)) apply(read)
    },
    snapshot: () => sink.snapshot(),
    done: () => {
      records.flush()
      return sink.snapshot()
    },
    unread: () => sink.unreadRecords,
    get needsReset() {
      return needsReset
    },
    get unchanged() {
      return sink.unchanged
    },
    get resume() {
      return sink.resume
    },
  }
}
