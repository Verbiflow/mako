import { fork, type ChildProcess } from "node:child_process"
import { createReadStream, existsSync, type Dirent } from "node:fs"
import { fileURLToPath } from "node:url"
import { lstat, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { setImmediate as nextTurn } from "node:timers/promises"
import { zstdDecompressSync } from "node:zlib"
import { z } from "zod"
import type { DatabaseSync, SQLOutputValue } from "node:sqlite"
import { levelDbEntries, levelDbFolder, snappyDecompress } from "./leveldb-text.js"
import { openReadOnly } from "./read-only-sqlite.js"
import { JsonValueSchema, jsonStoreAccess, unknownFields, type JsonValue } from "./store-format.js"

/**
 * Attachment files Mako keeps, given back once nothing can name them. Three
 * kinds of folder, each content- or time-addressed:
 *
 * - `archive`: `~/.mako/archive/assets`, saved beside the archive's copies
 *   until 2026-10-18 (and still by older builds sharing the folder);
 * - `live`: each profile's `LiveAssets`, `<data root>/conversations/assets`,
 *   what its conversations' prompts and long call fields were kept as;
 * - `staged`: `~/.mako/attachments`, the files a draft stages
 *   (`<time>-<random>-<name>`) and those an earlier build's translation into
 *   a harness wrote (`<sha256>-<name>`).
 *
 * A pass marks and sweeps, in the catalog worker right after the archive's
 * migration, under the backfill's lock:
 *
 * - **Mark.** Every store a reader of these files can name one in, for
 *   every build and profile sharing `~/.mako`: the archive's rows and legacy
 *   folders, the stores beside it (the Thread store, the session ledger,
 *   kept outputs), the view store, and under each profile's data root and
 *   renderer folder its journals, native requests, own stores and
 *   localStorage (drafts and the outbox); and the localStorage of every
 *   browser a development desk may have run in (`AttachmentReaders`, found
 *   by the host). A name is a path's tail (`archive/assets/`,
 *   `conversations/assets/`, `.mako/attachments/`, in any spelling) and the
 *   name's identifying head (a hash, a UUID, a staging time), and it marks
 *   every file of that kind with that head. Each source is read again only
 *   when its stamp moved; the archive and a LevelDB folder keep what each
 *   row or file named. SQLite hands over only the JSON strings that hold a
 *   tail (`json_tree`), so a 30 MB row never reaches the heap.
 * - **Hold.** What can't be read names everything: a source or folder that
 *   should have been read, and a browser a desk is known to have run in
 *   whose storage can't be read (Safari's, without Full Disk Access), for
 *   every file there at its last run. Where it can't be known (before Mako
 *   recorded which browsers open a desk), every staged file is held: drafts
 *   have no retention.
 * - **Sweep.** A file no mark or hold names, whose newest time (written,
 *   changed or created) is older than `graceMs`, moves into its folder's
 *   trash (`<folder>-trash`) by a rename. Then the stores are marked again
 *   and a file named since comes straight back: another build may name an
 *   existing file of the same bytes meanwhile.
 * - **Delete, later.** A trashed file is deleted by a later pass once it has
 *   sat there `keepTrashMs` and that pass's mark still names nothing of it;
 *   one named again goes back. A crash at any point leaves each file in one
 *   folder or the other.
 *
 * A file the record store holds the bytes of is still kept while any reader
 * names its path: no reader of these paths, in this build or an older one,
 * reads attachment bytes back from the store. A staged file named by its
 * hash is kept: an earlier build's translation into a harness names it, and
 * harnesses' records aren't read. Otherwise harness records aren't marked:
 * every prompt Mako sent with a file is in a journal or the native requests,
 * which Mako never deletes, and a transcript carries its own copies.
 *
 * `attachment-sweep.json` in the shared folder keeps the marks and the
 * trash's times, with a `version` as JSON stores keep it (`jsonStoreAccess`):
 * a newer build that learns another reader raises it, and this one then
 * reports but sweeps nothing.
 */

/** The sweep's format; a newer build that marks a reader this one doesn't raises it. */
const FORMAT = 1
const STATE_FILE = "attachment-sweep.json"
/** A file younger than this is never taken: a copy may not have reached the store that names it yet. */
export const ASSET_GRACE_MS = 60 * 60_000
/** How long a trashed file waits before a pass deletes it: the time a wrong sweep can be undone in. */
export const ASSET_TRASH_KEEP_MS = 24 * 60 * 60_000
/** Rows read at once from one table, between turns of the event loop. */
const ROWS_AT_ONCE = 128
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** A text file is read in pieces this large, each overlapping the last by more than a name. */
const TEXT_PIECE = 1024 * 1024
const OVERLAP = 512
/** The longest name head read after a tail. */
const HEAD_CHARS = 120

export type FolderKind = "archive" | "live" | "staged"
const KINDS: readonly FolderKind[] = ["archive", "live", "staged"]

/** A readable store of a browser a desk may have run in; `chromium` is a LevelDB folder of which only loopback origins are read. */
export interface BrowserStore {
  path: string
  kind: "chromium" | "firefox" | "webkit"
  label: string
}

/** Files of `kinds` that existed by `through` are named by what can't be read (`why`); with `root`, only that data root's `LiveAssets`. */
export interface AttachmentHold {
  kinds: FolderKind[]
  through: number
  why: string
  root?: string
}

/** Where every reader on this machine keeps its stores, as the host finds them each pass. */
export interface AttachmentReaders {
  /** Every Mako data root and desktop client's folder; each data root's `conversations/assets` is swept. */
  roots: string[]
  browsers: BrowserStore[]
  holds: AttachmentHold[]
  /** Folders that should have been read and couldn't: each names everything. */
  unreadable: { path: string; why: string }[]
}

export interface AttachmentSweepOptions {
  /** The archive's folder; its attachments are `assets/` in it. */
  archive: string
  /** The folder every build of this user shares (`~/.mako`); the archive's parent by default. */
  shared?: string
  /** The view store's folder (`makoViews()`). */
  views?: string
  readers: () => Promise<AttachmentReaders>
  /**
   * Runs a source's read in a child process of this executable (Electron's
   * Helper inside the app), one child a pass: SQLite holds a large value
   * whole while it searches it, and the allocator keeps what it freed, so
   * the reads' memory leaves with the child. Without it, sources are read in
   * this process.
   */
  aside?: string
  /** Where the marks and the trash's times are kept; null keeps them in memory, for a dry run that writes nothing. */
  state?: string | null
  graceMs?: number
  keepTrashMs?: number
  now?: () => number
}

export interface AttachmentSweepControl {
  stopped(): boolean
  yieldToPerson(): Promise<void>
}

export interface AttachmentSweepPassOptions {
  /** Move, restore and delete; without it the pass only reports what it would do. */
  sweep: boolean
  /** Tests stop the process here: after a file moved into the trash, before the pass goes on. */
  onTrashed?: (path: string) => void | Promise<void>
  /** Tests write here, between the first mark and the moves. */
  afterMark?: () => void | Promise<void>
}

export interface FilesAndBytes {
  files: number
  bytes: number
}

/** One folder's standing after a pass. */
export interface FolderReport {
  kind: FolderKind
  path: string
  files: number
  bytes: number
  named: FilesAndBytes
  /** Named by nothing but held by what can't be read. */
  held: FilesAndBytes
  /** Named by nothing, but written within the grace period. */
  young: FilesAndBytes
  /** Named by nothing and past the grace period: what a sweep takes (a dry run's answer). */
  reclaimable: FilesAndBytes
  /** Files kept whatever names them: not named by a head, or staged by a hash. */
  kept: FilesAndBytes
  trashed: FilesAndBytes
  restored: number
  deleted: FilesAndBytes
  trash: FilesAndBytes
}

export interface AttachmentSweepReport {
  /** Whether the stores were read this pass; false when nothing had moved since the last. */
  ran: boolean
  swept: boolean
  /** Why nothing was moved or deleted: a source that couldn't be read, a newer sweep's format. */
  stopped?: string
  /** Each folder by its label (`archive`, `staged`, `live <profile>`). */
  folders: Record<string, FolderReport>
  /** Each reader and hold, and the files it names. */
  owners: Record<string, FilesAndBytes>
  sources: { total: number; read: number; cached: number; unreadable: number }
  unreadable: { path: string; why: string }[]
  holds: { why: string; through: number }[]
  ms: number
  yieldedMs: number
  /** The slowest sources read this pass, slowest first, at most five. */
  slowest: { path: string; ms: number }[]
  /** The most memory the pass's reading child held, when sources were read in one. */
  childPeakRss?: number
}

type SourceKind = "archive" | "sqlite" | "text" | "leveldb" | "chromium" | "firefox" | "webkit"
interface Source {
  path: string
  kind: SourceKind
  owner: string
  stamp: string
}

const PartsSchema = z.record(z.string(), z.object({ token: z.string(), names: z.array(z.string()) }))
type Parts = z.infer<typeof PartsSchema>
const StateSchema = z.object({
  version: z.number(),
  sources: z.record(z.string(), z.object({ stamp: z.string(), names: z.array(z.string()), parts: PartsSchema.optional() })).catch({}),
  /** Each trashed file's path in the trash, and when it went there. */
  trashed: z.record(z.string(), z.number()).catch({}),
  /** What the last full pass found, for a pass that finds nothing moved. */
  quiet: z.object({ key: z.string(), due: z.number(), report: z.json() }).optional().catch(undefined),
}).loose()
type State = z.infer<typeof StateSchema>

/** A file of a swept folder. */
interface AttachmentFile {
  path: string
  name: string
  /** The head its names are matched by; null for a file no name can name. */
  head: string | null
  temporary: boolean
  bytes: number
  /** The newest of its written, changed and created times: the grace runs from it. */
  newest: number
  /** When it came to be, as far as can be told: a hold names it if it existed by then. */
  born: number
}

interface SweptFolder {
  label: string
  kind: FolderKind
  path: string
  trash: string
  /** The data root whose `LiveAssets` it is. */
  root?: string
}

interface Marks {
  /** `<kind>:<head>` to the readers naming it. */
  named: Map<string, Set<string>>
  unreadable: { path: string; why: string }[]
  stopped: boolean
}

/** An error that says the file is gone: it names nothing. */
const Gone = z.object({ code: z.enum(["ENOENT", "ENOTDIR"]) })
const Text = z.string()
const HASH = /^([0-9a-f]{64})-/
const UUID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})-/
/** `files.ts` staging: `Date.now()` and a random number, each in base 36. */
const STAMP = /^([0-9a-z]{1,12}-[0-9a-z]{1,8})-/
const NAME_CHAR = /[A-Za-z0-9._-]/

/** The head a name is matched by: its hash, its UUID, or its staging time and number. */
export function headOf(name: string): string | null {
  return HASH.exec(name)?.[1] ?? UUID.exec(name)?.[1] ?? STAMP.exec(name)?.[1] ?? null
}

/** A folder's tail in one spelling: its parent, a separator, its own name and a separator, as UTF-8 or UTF-16 bytes. */
interface Tail {
  kind: FolderKind
  text: string
  /** Its own name (`assets`, `attachments`), which a search finds first. */
  word: string
  /** How many characters come before the word. */
  before: number
  bytes: Buffer
  width: 1 | 2
}

/** Each kind's folder tail in every spelling a store uses: plain, Windows', JSON-escaped either way. */
export function tailsOf(shared: string): Tail[] {
  const folders: [FolderKind, string, string][] = [["archive", "archive", "assets"], ["live", "conversations", "assets"], ["staged", basename(shared), "attachments"]]
  return folders.flatMap(([kind, parent, word]) => ["/", "\\", "\\\\", "\\/"].map((separator) => ({ text: `${parent}${separator}${word}${separator}`, before: parent.length + separator.length })).flatMap(({ text, before }) => [
    { kind, text, word, before, bytes: Buffer.from(text, "latin1"), width: 1 as const },
    { kind, text, word, before, bytes: Buffer.from(text, "utf16le"), width: 2 as const },
  ]))
}

/** The words every tail ends in, each in both widths, with the tails that end in it. */
function anchorsOf(tails: readonly Tail[]): { word: Buffer; width: 1 | 2; tails: Tail[] }[] {
  const anchors = new Map<string, { word: Buffer; width: 1 | 2; tails: Tail[] }>()
  for (const tail of tails) {
    const key = `${tail.word}:${tail.width}`
    const anchor = anchors.get(key) ?? { word: Buffer.from(tail.word, tail.width === 1 ? "latin1" : "utf16le"), width: tail.width, tails: [] }
    anchor.tails.push(tail)
    anchors.set(key, anchor)
  }
  return [...anchors.values()]
}

/**
 * The names `bytes` holds, as `<kind>:<head>`: each place a tail's word
 * (`assets`, `attachments`) appears is checked for a whole tail around it,
 * then a name's head is read after it, as UTF-8 or UTF-16. Four searches of
 * the bytes, whatever the number of spellings.
 */
export function namesIn(bytes: Uint8Array, tails: readonly Tail[], into: Set<string>): void {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (const anchor of anchorsOf(tails)) {
    for (let at = buffer.indexOf(anchor.word); at >= 0; at = buffer.indexOf(anchor.word, at + 1)) {
      for (const tail of anchor.tails) {
        const start = at - tail.before * tail.width
        if (start < 0 || start + tail.bytes.length > buffer.length || buffer.compare(tail.bytes, 0, tail.bytes.length, start, start + tail.bytes.length) !== 0) continue
        let name = ""
        for (let offset = start + tail.bytes.length; name.length < HEAD_CHARS && offset + tail.width <= buffer.length; offset += tail.width) {
          if (tail.width === 2 && buffer[offset + 1] !== 0) break
          const char = String.fromCharCode(buffer[offset]!)
          if (!NAME_CHAR.test(char)) break
          name += char
        }
        const head = headOf(name)
        if (head) into.add(`${tail.kind}:${head}`)
      }
    }
  }
}

/** The names `text` holds, found as `namesIn` finds them; a head is copied out, never kept as a slice of a large string. */
export function namesInText(text: string, tails: readonly Tail[], into: Set<string>): void {
  for (const anchor of anchorsOf(tails)) {
    if (anchor.width !== 1) continue
    const word = anchor.tails[0]!.word
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
      for (const tail of anchor.tails) {
        const start = at - tail.before
        if (start < 0 || !text.startsWith(tail.text, start)) continue
        let end = start + tail.text.length
        const name = end
        while (end - name < HEAD_CHARS && end < text.length && NAME_CHAR.test(text[end]!)) end += 1
        const head = headOf(text.slice(name, end))
        if (head) into.add(`${tail.kind}:${Buffer.from(head, "latin1").toString("latin1")}`)
      }
    }
  }
}

export class AttachmentSweep {
  private readonly shared: string
  private readonly tails: Tail[]
  private readonly statePath: string | null
  private readonly graceMs: number
  private readonly keepTrashMs: number
  private readonly now: () => number
  private state: State | null = null
  /** The pass's reading child; false once one couldn't start. */
  private child: NamesAside | null | false = null
  /** The largest the pass's child grew, for the report. */
  private childPeakRss = 0
  /** The state file as read, whose fields this build doesn't name are written back as they were. */
  private raw: JsonValue = { version: FORMAT }

  constructor(private readonly options: AttachmentSweepOptions) {
    this.shared = options.shared ?? dirname(options.archive)
    this.tails = tailsOf(this.shared)
    this.statePath = options.state === undefined ? join(this.shared, STATE_FILE) : options.state
    this.graceMs = options.graceMs ?? ASSET_GRACE_MS
    this.keepTrashMs = options.keepTrashMs ?? ASSET_TRASH_KEEP_MS
    this.now = options.now ?? Date.now
  }

  /** The folders swept: the archive's, the staged files', and each data root's `LiveAssets`. */
  private folders(readers: AttachmentReaders): SweptFolder[] {
    const folder = (label: string, kind: FolderKind, path: string, root?: string): SweptFolder => ({ label, kind, path, trash: `${path}-trash`, ...root && { root } })
    const found = [folder("archive", "archive", join(this.options.archive, "assets")), folder("staged", "staged", join(this.shared, "attachments"))]
    for (const root of [...new Set(readers.roots)].sort()) found.push(folder(`live ${basename(root)}`, "live", join(root, "conversations", "assets"), root))
    return found.filter((entry) => existsSync(entry.path) || existsSync(entry.trash))
  }

  async pass(control: AttachmentSweepControl, pass: AttachmentSweepPassOptions): Promise<AttachmentSweepReport> {
    this.childPeakRss = 0
    try {
      const report = await this.passOnce(control, pass)
      return this.childPeakRss ? { ...report, childPeakRss: this.childPeakRss } : report
    } finally {
      if (this.child) this.child.close()
      this.child = null
    }
  }

  /** A source's names, read in the pass's child when there is one, else here. */
  private async read(source: Source, parts: Parts): Promise<{ found: Set<string>; parts?: Parts }> {
    if (this.options.aside && this.child !== false) {
      this.child ??= NamesAside.start(this.options.aside)
      const reply = this.child ? await this.child.read({ source, shared: this.shared, parts }) : null
      if (reply?.ok) {
        this.childPeakRss = Math.max(this.childPeakRss, reply.peakRss ?? 0)
        // What a large value left behind stays with the child; a fresh one takes the next source.
        if ((reply.rss ?? 0) > CHILD_RSS_LIMIT) {
          if (this.child) this.child.close()
          this.child = null
        }
        return { found: new Set(reply.found), ...reply.parts && { parts: reply.parts } }
      }
      if (reply) throw new Error(reply.error)
      // No child could run: this process reads.
      this.child = false
    }
    return readNames(source, this.tails, parts)
  }

  private async passOnce(control: AttachmentSweepControl, pass: AttachmentSweepPassOptions): Promise<AttachmentSweepReport> {
    const started = performance.now()
    const report = emptyReport()
    const state = await this.load()
    const writable = jsonStoreAccess(this.raw, FORMAT) === "write"
    let readers = await this.options.readers()
    const folders = this.folders(readers)
    if (!folders.length) return { ...report, ms: performance.now() - started }
    let found = await this.sources(readers)
    const now = this.now()
    if (pass.sweep && writable && state.quiet && state.quiet.key === (await this.quietKey(found, folders, readers)) && now < state.quiet.due) {
      const quiet = ReportSchema.safeParse(state.quiet.report)
      if (quiet.success) return { ...quiet.data, ran: false, swept: false, folders: Object.fromEntries(Object.entries(quiet.data.folders).map(([label, entry]) => [label, { ...entry, trashed: zero(), restored: 0, deleted: zero() }])), ms: performance.now() - started, yieldedMs: 0 }
    }
    report.ran = true
    let marks = await this.mark(found, state, control, report)
    await pass.afterMark?.()
    if (marks.stopped) return { ...report, stopped: "the pass was stopped", ms: performance.now() - started }
    const stopped = !writable
      ? `a newer Mako's sweep (format ${String(state.version)}) marks readers this build doesn't know`
      : marks.unreadable.length ? `${marks.unreadable[0]!.path} couldn't be read: ${marks.unreadable[0]!.why}` : undefined
    if (stopped) report.stopped = stopped
    const reports = new Map(folders.map((entry) => [entry.label, emptyFolder(entry)]))
    if (pass.sweep && !stopped) {
      report.swept = true
      const moved: { folder: SweptFolder; file: AttachmentFile }[] = []
      for (const folder of folders) {
        const counts = reports.get(folder.label)!
        for (const file of await this.files(folder.trash)) {
          state.trashed[file.path] ??= now
          if (this.named(folder, file, marks, readers)) {
            if (await this.restore(folder, file)) counts.restored += 1
          } else if (now - state.trashed[file.path]! >= this.keepTrashMs) {
            await unlessGone(unlink(file.path))
            delete state.trashed[file.path]
            add(counts.deleted, file.bytes)
          }
        }
        for (const file of await this.files(folder.path)) {
          if (!this.takes(folder, file, marks, readers, now)) continue
          if (control.stopped()) break
          await mkdir(folder.trash, { recursive: true })
          const to = join(folder.trash, file.name)
          if (!(await unlessGone(rename(file.path, to)))) continue
          state.trashed[to] = now
          moved.push({ folder, file: { ...file, path: to } })
          add(counts.trashed, file.bytes)
          await pass.onTrashed?.(to)
        }
      }
      if (moved.length) {
        // Named since the first mark (another build's new copy of the same bytes, a prompt reusing one): straight back.
        readers = await this.options.readers()
        found = await this.sources(readers)
        marks = await this.mark(found, state, { stopped: () => false, yieldToPerson: () => control.yieldToPerson() }, emptyReport())
        for (const { folder, file } of moved) {
          if (!marks.unreadable.length && !this.named(folder, file, marks, readers)) continue
          if (!(await this.restore(folder, file))) continue
          const counts = reports.get(folder.label)!
          counts.restored += 1
          sub(counts.trashed, file.bytes)
        }
      }
    } else if (pass.sweep && writable && marks.unreadable.length) {
      // A source that names everything names what's in the trash too.
      for (const folder of folders)
        for (const file of await this.files(folder.trash)) if (await this.restore(folder, file)) reports.get(folder.label)!.restored += 1
    }
    const due = await this.count(report, reports, folders, marks, readers, now)
    report.sources.total = found.sources.length
    report.unreadable = marks.unreadable
    report.holds = readers.holds.map(({ why, through }) => ({ why, through }))
    report.ms = performance.now() - started
    if (!pass.sweep || !writable) return report
    if (stopped) delete state.quiet
    else state.quiet = { key: await this.quietKey(found, folders, readers), due, report: JSON.parse(JSON.stringify(report)) }
    await this.save(state)
    return report
  }

  /** Moves every trashed file back, for undoing a sweep by hand; returns how many. */
  async restoreAll(): Promise<number> {
    const state = await this.load()
    if (jsonStoreAccess(this.raw, FORMAT) !== "write") throw new Error("A newer Mako's sweep keeps this trash; update Mako to restore it")
    let restored = 0
    for (const folder of this.folders(await this.options.readers()))
      for (const file of await this.files(folder.trash)) if (await this.restore(folder, file)) restored += 1
    state.trashed = {}
    delete state.quiet
    await this.save(state)
    return restored
  }

  /** What names `file`, if anything does: a mark, or a hold over its kind from before it came to be. */
  private namer(folder: SweptFolder, file: AttachmentFile, marks: Marks, readers: AttachmentReaders): Set<string> | string | null {
    if (file.head) {
      const owners = marks.named.get(`${folder.kind}:${file.head}`)
      if (owners) return owners
    }
    const hold = readers.holds.find((entry) => entry.kinds.includes(folder.kind) && (!entry.root || entry.root === folder.root) && file.born <= entry.through)
    return hold ? hold.why : null
  }

  private named(folder: SweptFolder, file: AttachmentFile, marks: Marks, readers: AttachmentReaders): boolean {
    return this.namer(folder, file, marks, readers) !== null || this.kept(folder, file)
  }

  /** Never taken: a file no name's head can name, and a staged file named by its hash (an earlier build's translation names it). */
  private kept(folder: SweptFolder, file: AttachmentFile): boolean {
    if (file.temporary) return false
    return !file.head || (folder.kind === "staged" && HASH.test(file.name))
  }

  /** Whether a sweep takes `file`: named by nothing, held by nothing, and past the grace period. */
  private takes(folder: SweptFolder, file: AttachmentFile, marks: Marks, readers: AttachmentReaders, now: number): boolean {
    return !this.named(folder, file, marks, readers) && now - file.newest >= this.graceMs
  }

  /** Back from the trash; a copy written there since (the same name, so the same bytes or the same staging) is kept and the trash's dropped. */
  private async restore(folder: SweptFolder, file: AttachmentFile): Promise<boolean> {
    const to = join(folder.path, file.name)
    const there = await lstat(to).catch(() => null)
    if (!there) {
      await mkdir(folder.path, { recursive: true })
      await unlessGone(rename(file.path, to))
    } else if (there.isFile() && there.size === file.bytes) await unlessGone(unlink(file.path))
    else return false
    if (this.state) delete this.state.trashed[file.path]
    return true
  }

  /**
   * What the report counts, from the folders as the pass leaves them, and
   * when a pass next has something to do though nothing moved: a young file
   * past its grace, a trashed one due.
   */
  private async count(report: AttachmentSweepReport, reports: Map<string, FolderReport>, folders: SweptFolder[], marks: Marks, readers: AttachmentReaders, now: number): Promise<number> {
    let due = now + this.keepTrashMs
    for (const at of Object.values(this.state?.trashed ?? {})) due = Math.min(due, at + this.keepTrashMs)
    for (const folder of folders) {
      const counts = reports.get(folder.label)!
      for (const file of await this.files(folder.path)) {
        counts.files += 1
        counts.bytes += file.bytes
        const namer = this.namer(folder, file, marks, readers)
        if (namer instanceof Set) {
          add(counts.named, file.bytes)
          for (const owner of namer) add((report.owners[owner] ??= zero()), file.bytes)
        } else if (this.kept(folder, file)) add(counts.kept, file.bytes)
        else if (namer !== null) {
          add(counts.held, file.bytes)
          add((report.owners[namer] ??= zero()), file.bytes)
        } else if (now - file.newest < this.graceMs) {
          add(counts.young, file.bytes)
          due = Math.min(due, file.newest + this.graceMs)
        } else add(counts.reclaimable, file.bytes)
      }
      for (const file of await this.files(folder.trash)) add(counts.trash, file.bytes)
      report.folders[folder.label] = counts
    }
    return due
  }

  /** Every file in `folder`, with its size and times; nothing when there's no folder. */
  private async files(folder: string): Promise<AttachmentFile[]> {
    let entries: Dirent[]
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch (error) {
      if (Gone.safeParse(error).success) return []
      throw error
    }
    const files: AttachmentFile[] = []
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const path = join(folder, entry.name)
      const info = await lstat(path).catch(() => null)
      if (!info?.isFile()) continue
      const head = headOf(entry.name)
      // A staged name carries the time it was staged; a copy keeps an older mtime than its birth.
      const staged = head && STAMP.test(entry.name) && !HASH.test(entry.name) && !UUID.test(entry.name) ? Number.parseInt(head.split("-")[0]!, 36) : Number.POSITIVE_INFINITY
      files.push({
        path,
        name: entry.name,
        head,
        temporary: entry.name.endsWith(".tmp"),
        bytes: info.size,
        newest: Math.max(info.mtimeMs, info.ctimeMs, info.birthtimeMs),
        born: Math.min(staged, info.mtimeMs, info.birthtimeMs || info.mtimeMs),
      })
    }
    return files
  }

  /**
   * Every source a reader names attachments in, stamped. A folder that
   * exists and can't be listed is unreadable; one that's gone names nothing.
   */
  private async sources(readers: AttachmentReaders): Promise<{ sources: Source[]; unreadable: { path: string; why: string }[] }> {
    const sources: Source[] = []
    const unreadable = [...readers.unreadable]
    const list = async (folder: string, pick: (name: string) => boolean): Promise<string[]> => {
      try {
        return (await readdir(folder)).filter(pick).sort().map((name) => join(folder, name))
      } catch (error) {
        if (!Gone.safeParse(error).success) unreadable.push({ path: folder, why: String(error) })
        return []
      }
    }
    const add = async (path: string, kind: SourceKind, owner: string) => {
      try {
        const stamp = await stampOf(path, kind)
        if (stamp) sources.push({ path, kind, owner, stamp })
      } catch (error) {
        unreadable.push({ path, why: String(error) })
      }
    }
    const sqlite = (name: string) => name.endsWith(".sqlite") || name.endsWith(".db")
    for (const path of await list(this.options.archive, sqlite))
      await (basename(path) === "archive.sqlite" ? add(path, "archive", "archive") : add(path, "sqlite", `archive ${basename(path)}`))
    for (const folder of await list(this.options.archive, (name) => /^[0-9a-f]{24}$/.test(name)))
      for (const path of await list(folder, (name) => /\.jsonl?$/.test(name))) await add(path, "text", "archive")
    for (const path of await list(this.shared, sqlite)) await add(path, "sqlite", basename(path))
    if (this.options.views)
      for (const path of await list(this.options.views, sqlite)) await add(path, "sqlite", "views")
    for (const root of [...new Set(readers.roots)].sort()) {
      const name = basename(root)
      const own = await list(root, () => true)
      for (const path of own.filter((path) => sqlite(path))) await add(path, "sqlite", `${name} ${basename(path)}`)
      for (const path of own.filter((path) => path.endsWith(".json"))) await add(path, "text", `${name} ${basename(path)}`)
      for (const path of await list(join(root, "conversations"), sqlite)) await add(path, "sqlite", `journals ${name}`)
      for (const path of await list(join(root, "native-requests"), sqlite)) await add(path, "sqlite", `native requests ${name}`)
      for (const path of await list(join(root, "cloud"), (file) => file.endsWith(".json"))) await add(path, "text", `${name} cloud`)
      const renderers = [join(root, "Local Storage", "leveldb"), ...(await list(join(root, "Partitions"), () => true)).map((partition) => join(partition, "Local Storage", "leveldb"))]
      for (const folder of renderers) if (existsSync(folder)) await add(folder, "leveldb", `drafts ${name}`)
    }
    for (const browser of readers.browsers) await add(browser.path, browser.kind, `drafts ${browser.label}`)
    return { sources, unreadable }
  }

  /** Every name in every source: a source whose stamp hasn't moved from the last pass's marks, the rest read now. */
  private async mark(found: { sources: Source[]; unreadable: { path: string; why: string }[] }, state: State, control: AttachmentSweepControl, report: AttachmentSweepReport): Promise<Marks> {
    const named = new Map<string, Set<string>>()
    const unreadable = [...found.unreadable]
    const seen = new Set<string>()
    report.sources.read = 0
    report.sources.cached = 0
    for (const source of found.sources) {
      seen.add(source.path)
      let names: string[]
      const cached = state.sources[source.path]
      if (cached && cached.stamp === source.stamp) {
        names = cached.names
        report.sources.cached += 1
      } else {
        if (control.stopped()) return { named, unreadable, stopped: true }
        const yielded = performance.now()
        await control.yieldToPerson()
        report.yieldedMs += performance.now() - yielded
        const reading = performance.now()
        let parts: Parts | undefined
        try {
          const read = await this.read(source, cached?.parts ?? {})
          names = [...read.found].sort()
          parts = read.parts
        } catch (error) {
          delete state.sources[source.path]
          if (!existsSync(source.path)) continue
          unreadable.push({ path: source.path, why: String(error) })
          continue
        }
        const took = Math.round(performance.now() - reading)
        report.slowest = [...report.slowest, { path: source.path, ms: took }].sort((a, b) => b.ms - a.ms).slice(0, 5)
        state.sources[source.path] = { stamp: source.stamp, names, ...parts && { parts } }
        report.sources.read += 1
      }
      for (const name of names) {
        const owners = named.get(name) ?? new Set<string>()
        owners.add(source.owner)
        named.set(name, owners)
      }
    }
    for (const path of Object.keys(state.sources)) if (!seen.has(path)) delete state.sources[path]
    report.sources.unreadable = unreadable.length
    return { named, unreadable, stopped: false }
  }

  /** What would make a pass different: every source's stamp, the folders', and the holds. */
  private async quietKey(found: { sources: Source[]; unreadable: { path: string }[] }, folders: SweptFolder[], readers: AttachmentReaders): Promise<string> {
    const stamps = await Promise.all(folders.flatMap((folder) => [folder.path, folder.trash]).map(async (folder) => {
      const info = await stat(folder).catch(() => null)
      return info ? `${info.mtimeMs}:${info.ctimeMs}:${info.ino}` : "-"
    }))
    return JSON.stringify([stamps, found.sources.map((source) => [source.path, source.stamp]), found.unreadable.map((entry) => entry.path), readers.holds])
  }

  private async load(): Promise<State> {
    if (this.state) return this.state
    const fresh = (): State => ({ version: FORMAT, sources: {}, trashed: {} })
    if (!this.statePath) return (this.state = fresh())
    const text = await readFile(this.statePath, "utf8").catch(() => null)
    if (text === null) return (this.state = fresh())
    try {
      this.raw = JsonValueSchema.parse(JSON.parse(text))
      const parsed = StateSchema.safeParse(this.raw)
      return (this.state = parsed.success ? parsed.data : fresh())
    } catch {
      return (this.state = fresh())
    }
  }

  private async save(state: State): Promise<void> {
    if (!this.statePath) return
    const temporary = `${this.statePath}.${process.pid}.tmp`
    await mkdir(dirname(this.statePath), { recursive: true })
    await writeFile(temporary, JSON.stringify({ ...unknownFields(this.raw, ["version", "sources", "trashed", "quiet"]), ...state, version: FORMAT }))
    await rename(temporary, this.statePath)
  }
}

const FilesAndBytesSchema = z.object({ files: z.number(), bytes: z.number() })
const FolderSchema = z.object({
  kind: z.enum(KINDS), path: z.string(), files: z.number(), bytes: z.number(),
  named: FilesAndBytesSchema, held: FilesAndBytesSchema, young: FilesAndBytesSchema, reclaimable: FilesAndBytesSchema, kept: FilesAndBytesSchema,
  trashed: FilesAndBytesSchema, restored: z.number(), deleted: FilesAndBytesSchema, trash: FilesAndBytesSchema,
})
const ReportSchema = z.object({
  ran: z.boolean(), swept: z.boolean(), stopped: z.string().optional(),
  folders: z.record(z.string(), FolderSchema), owners: z.record(z.string(), FilesAndBytesSchema),
  sources: z.object({ total: z.number(), read: z.number(), cached: z.number(), unreadable: z.number() }),
  unreadable: z.array(z.object({ path: z.string(), why: z.string() })),
  holds: z.array(z.object({ why: z.string(), through: z.number() })),
  ms: z.number(), yieldedMs: z.number(), slowest: z.array(z.object({ path: z.string(), ms: z.number() })), childPeakRss: z.number().optional(),
})

/** A reading child holding more than this after a source is let go, and the next source starts a fresh one. */
const CHILD_RSS_LIMIT = 128 * 1024 * 1024

export const NamesJobSchema = z.object({
  source: z.object({ path: z.string(), kind: z.enum(["archive", "sqlite", "text", "leveldb", "chromium", "firefox", "webkit"]), owner: z.string(), stamp: z.string() }),
  shared: z.string(),
  parts: PartsSchema,
})
export type NamesJob = z.infer<typeof NamesJobSchema>
export const NamesReplySchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), found: z.array(z.string()), parts: PartsSchema.optional(), peakRss: z.number().optional(), rss: z.number().optional() }),
  z.object({ ok: z.literal(false), error: z.string() }),
])
export type NamesReply = z.infer<typeof NamesReplySchema>

/** What a child read, given what it was asked (`attachment-names-main.ts`). */
export async function readJob(job: NamesJob, pressure: Pressure = NO_PRESSURE): Promise<NamesReply> {
  try {
    const read = await readNames(job.source, tailsOf(job.shared), job.parts, pressure)
    return { ok: true, found: [...read.found], ...read.parts && { parts: read.parts }, peakRss: process.resourceUsage().maxRSS * 1024, rss: process.memoryUsage().rss }
  } catch (error) {
    return { ok: false, error: String(error) }
  }
}

/**
 * The pass's reading child: `attachment-names-main.js` under `executable`,
 * one job at a time over IPC, gone when the pass ends. Its allocator gives
 * back nothing it doesn't have to (`MallocLargeCache=0` on macOS), so its
 * peak is what its reads hold.
 */
class NamesAside {
  private pending: { resolve: (reply: NamesReply | null) => void } | null = null
  private exited = false

  private constructor(private readonly child: ChildProcess) {
    child.on("message", (message) => {
      const waiting = this.pending
      this.pending = null
      waiting?.resolve(NamesReplySchema.safeParse(message).data ?? { ok: false, error: "the child's reply doesn't parse" })
    })
    child.once("exit", () => {
      this.exited = true
      const waiting = this.pending
      this.pending = null
      waiting?.resolve(null)
    })
    child.once("error", () => {
      this.exited = true
      this.pending?.resolve(null)
      this.pending = null
    })
  }

  static start(executable: string): NamesAside | null {
    // Built, the child is beside this module; read from source (a script under tsx), it runs under tsx too.
    const built = [new URL("./attachment-names-main.js", import.meta.url), new URL("../dist/attachment-names-main.js", import.meta.url)].map((url) => fileURLToPath(url)).find((path) => existsSync(path))
    const source = fileURLToPath(new URL("./attachment-names-main.ts", import.meta.url))
    const script = built ?? (existsSync(source) ? source : null)
    if (!script) return null
    try {
      return new NamesAside(fork(script, [], {
        execPath: executable,
        // `gc`: the child collects as it reads, so what it holds stays near one value (`attachment-names-main.ts`).
        execArgv: [...script === source ? ["--import", "tsx"] : [], "--expose-gc"],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", MallocLargeCache: "0" },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        serialization: "json",
      }))
    } catch {
      return null
    }
  }

  /** The child's reply, or null when it's gone (the caller reads in its own process). */
  read(job: NamesJob): Promise<NamesReply | null> {
    if (this.exited) return Promise.resolve(null)
    return new Promise((resolve) => {
      this.pending = { resolve }
      this.child.send(job, (error) => {
        if (!error) return
        this.pending = null
        resolve(null)
      })
    })
  }

  close(): void {
    if (!this.exited) this.child.kill()
  }
}

/** The names a source holds, and for a source read in parts (the archive's rows, a LevelDB folder's files) what each part named. */
/** Told the bytes each read brought into memory; the reading child collects its garbage by it. */
type Pressure = (bytes: number) => void
const NO_PRESSURE: Pressure = () => {}

async function readNames(source: Source, tails: readonly Tail[], parts: Parts, pressure: Pressure = NO_PRESSURE): Promise<{ found: Set<string>; parts?: Parts }> {
  const found = new Set<string>()
  switch (source.kind) {
    case "archive":
      return { found, parts: await archiveNames(source.path, tails, parts, found, pressure) }
    case "leveldb":
    case "chromium":
      return { found, parts: await levelDbNames(source.path, tails, parts, found, source.kind === "chromium" ? loopbackKey : () => true, pressure) }
    case "firefox":
      await firefoxNames(source.path, tails, found)
      return { found }
    case "webkit":
      await everyValueNames(source.path, tails, found)
      return { found }
    case "sqlite":
      await sqliteNames(source.path, tails, found, pressure)
      return { found }
    case "text":
      await textNames(source.path, tails, found, pressure)
      return { found }
  }
}

/**
 * A LevelDB folder file by file: a file read before at the same size and
 * time names what it named then (a table never changes; a log only grows,
 * which moves its stamp). `keep` picks the entries read by their key.
 */
async function levelDbNames(folder: string, tails: readonly Tail[], before: Parts, into: Set<string>, keep: (key: Buffer | null) => boolean, pressure: Pressure): Promise<Parts> {
  const parts: Parts = {}
  await levelDbFolder(folder, async (path) => {
    const token = (await stampOf(path, "text")) ?? "-"
    const name = basename(path)
    let names = before[name]?.token === token ? before[name]!.names : null
    if (!names) {
      const found = new Set<string>()
      const entries = await levelDbEntries(path)
      for (const entry of entries) if (keep(entry.key)) namesIn(entry.value, tails, found)
      pressure(entries.reduce((total, entry) => total + entry.value.length, 0))
      names = [...found].sort()
    }
    parts[name] = { token, names }
  })
  for (const part of Object.values(parts)) for (const name of part.names) into.add(name)
  return parts
}

/**
 * A browser's localStorage entry for a desk: Chromium keys a value
 * `_<origin>\0<encoding><key>`, and a desk is served from a loopback origin
 * (Vite's `127.0.0.1`, `localhost`, `[::1]` or a name under `.localhost`, on
 * any port). An entry with no key (a log record this reader couldn't split)
 * is read whole.
 */
function loopbackKey(key: Buffer | null): boolean {
  if (!key) return true
  if (key[0] !== 0x5f) return false
  const end = key.indexOf(0)
  return isLoopbackOrigin(key.subarray(1, end < 0 ? key.length : end).toString("latin1"))
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin)
    if (url.protocol !== "http:" && url.protocol !== "https:") return false
    return ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.hostname.endsWith(".localhost")
  } catch {
    return false
  }
}

const FirefoxRowSchema = z.object({ value: z.instanceof(Uint8Array).or(z.string()), compression_type: z.number().nullable().optional() })

/** Firefox's localStorage for one origin (`ls/data.sqlite`): each value, Snappy-compressed where its row says so. */
async function firefoxNames(path: string, tails: readonly Tail[], into: Set<string>): Promise<void> {
  const { database } = openReadOnly(path, { timeout: 2_000 })
  try {
    const columns = new Set(z.object({ name: z.string() }).array().parse(database.prepare("PRAGMA table_info(data)").all()).map((column) => column.name))
    const select = `SELECT value${columns.has("compression_type") ? ", compression_type" : ""} FROM data`
    for (const row of database.prepare(select).iterate()) {
      const { value, compression_type: compression } = FirefoxRowSchema.parse(row)
      const text = Text.safeParse(value)
      if (text.success) {
        namesInText(text.data, tails, into)
        continue
      }
      const bytes = Buffer.from(z.instanceof(Uint8Array).parse(value))
      namesIn(compression === 1 ? snappyDecompress(bytes) : bytes, tails, into)
    }
  } finally {
    database.close()
  }
}

/** Every value of every table, whatever its form: a small browser store (WebKit's `localstorage.sqlite3` keeps UTF-16 blobs). */
async function everyValueNames(path: string, tails: readonly Tail[], into: Set<string>): Promise<void> {
  const { database } = openReadOnly(path, { timeout: 2_000 })
  try {
    for (const table of tablesOf(database)) {
      if (table.virtual) continue
      for (const row of database.prepare(`SELECT * FROM ${quoted(table.name)}`).iterate()) for (const value of Object.values(row)) valueNames(value, tails, into)
      await nextTurn()
    }
  } finally {
    database.close()
  }
}

const ArchiveRowSchema = z.object({ path: z.string(), token: z.string().nullable() })

/**
 * The archive a row at a time: a row whose capture token (`archive_captures`,
 * which the archive's triggers move on every insert and update, whichever
 * build writes) is the one it was read at names what it named then, so an
 * older build writing a copy costs one row's read, not the archive's. Its
 * other tables are read whole. An archive without the token (none this build
 * would write) is read as any database.
 */
async function archiveNames(path: string, tails: readonly Tail[], before: Parts, into: Set<string>, pressure: Pressure): Promise<Parts> {
  const { database } = openReadOnly(path, { timeout: 2_000 })
  try {
    const tables = new Set(tablesOf(database).map((table) => table.name))
    if (!tables.has("sessions") || !tables.has("archive_captures")) {
      await databaseNames(database, tails, into, pressure)
      return {}
    }
    const parts: Parts = {}
    const reads = ["ref", "entries"].map((column) => valueReader(database, "sessions", column, tails, (table) => `${table}path = ?`, pressure))
    let since = performance.now()
    for (const row of ArchiveRowSchema.array().parse(database.prepare("SELECT s.path AS path, c.token AS token FROM sessions s LEFT JOIN archive_captures c ON c.path = s.path").all())) {
      const kept = before[row.path]
      let names: string[]
      if (row.token !== null && kept?.token === row.token) names = kept.names
      else {
        const found = new Set<string>()
        for (const read of reads) read([row.path], found)
        names = [...found].sort()
      }
      // A row with no token is read again next time.
      if (row.token !== null) parts[row.path] = { token: row.token, names }
      for (const name of names) into.add(name)
      if (performance.now() - since > 50) {
        await nextTurn()
        since = performance.now()
      }
    }
    await databaseNames(database, tails, into, pressure, (table) => table !== "sessions")
    return parts
  } finally {
    database.close()
  }
}

/** Every column of every table, a window of rows at a time. */
async function sqliteNames(path: string, tails: readonly Tail[], into: Set<string>, pressure: Pressure): Promise<void> {
  const { database } = openReadOnly(path, { timeout: 2_000 })
  try {
    await databaseNames(database, tails, into, pressure)
  } finally {
    database.close()
  }
}

const TableSchema = z.object({ name: z.string(), sql: z.string().nullable() })

function tablesOf(database: DatabaseSync): { name: string; virtual: boolean; withoutRowid: boolean }[] {
  return TableSchema.array().parse(database.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())
    .map((table) => ({ name: table.name, virtual: /^\s*create\s+virtual\s/i.test(table.sql ?? ""), withoutRowid: /without\s+rowid/i.test(table.sql ?? "") }))
}

/** Every column of every table but those `pick` leaves out; a virtual table's text is in its shadow tables, read as tables of their own. */
async function databaseNames(database: DatabaseSync, tails: readonly Tail[], into: Set<string>, pressure: Pressure, pick: (table: string) => boolean = () => true): Promise<void> {
  for (const table of tablesOf(database)) {
    if (!pick(table.name) || table.virtual) continue
    const columns = z.object({ name: z.string() }).array().parse(database.prepare(`PRAGMA table_info(${quoted(table.name)})`).all()).map((column) => column.name)
    if (table.withoutRowid) {
      for (const column of columns) valueReader(database, table.name, column, tails, () => "1", pressure, true)([], into)
      continue
    }
    const end = database.prepare(`SELECT max(id) AS id FROM (SELECT rowid AS id FROM ${quoted(table.name)} WHERE rowid > ? ORDER BY rowid LIMIT ${ROWS_AT_ONCE})`)
    end.setReadBigInts(true)
    const readers = columns.map((column) => valueReader(database, table.name, column, tails, (table) => `${table}rowid > ? AND ${table}rowid <= ?`, pressure))
    const Last = z.object({ id: z.bigint().nullable() })
    // A rowid is any 64-bit integer, and windows go by count, not by a range that may be sparse.
    let from = -(2n ** 63n)
    for (;;) {
      const last: bigint | null = Last.parse(end.get(from)).id
      if (last === null) break
      for (const read of readers) read([from, last], into)
      from = last
      await nextTurn()
    }
  }
}

/** A value comes over whole up to this many bytes, and a larger one in pieces this large (as many characters), so no value reaches the heap whole past it. */
const PIECE = 4 * 1024 * 1024
const PickedSchema = z.object({ id: z.bigint().nullable(), size: z.bigint().nullable(), length: z.bigint().nullable(), zstd: z.bigint(), small: z.instanceof(Uint8Array).nullable() })
const PieceSchema = z.object({ piece: z.union([z.instanceof(Uint8Array), z.string()]).nullable() })

/**
 * The names a column holds in the rows `where` picks. SQLite finds the
 * values that hold a folder's tail (and every zstd blob, a view's body),
 * and hands each over as its bytes: whole up to `PIECE`, else a piece at a
 * time by its rowid, each with the end of the one before.
 */
function valueReader(database: DatabaseSync, table: string, column: string, tails: readonly Tail[], where: (table: string) => string, pressure: Pressure, withoutRowid = false): (parameters: (string | bigint)[], into: Set<string>) => void {
  const value = `t.${quoted(column)}`
  // Two searches in SQLite; the tails, in every spelling, are matched on the bytes that come over (`namesIn`).
  const candidate = [...new Set(tails.map((tail) => tail.word))].map((word) => `instr(${value}, '${word}') > 0`).join(" OR ")
  const zstd = `(typeof(${value}) = 'blob' AND substr(${value}, 1, 4) = x'28b52ffd')`
  const whole = withoutRowid ? "1" : `octet_length(${value}) <= ${PIECE} OR ${zstd}`
  const picked = database.prepare(`SELECT ${withoutRowid ? "NULL" : "t.rowid"} AS id, octet_length(${value}) AS size, length(${value}) AS length, ${zstd} AS zstd, CASE WHEN ${whole} THEN CAST(${value} AS BLOB) END AS small FROM ${quoted(table)} t WHERE ${where("t.")} AND (${candidate} OR ${zstd})`)
  picked.setReadBigInts(true)
  // A large value a piece at a time, as it's kept: text by characters, so SQLite copies nothing to cast it.
  const piece = withoutRowid ? null : database.prepare(`SELECT substr(${value}, ?, ${PIECE + OVERLAP}) AS piece FROM ${quoted(table)} t WHERE t.rowid = ?`)
  return (parameters, into) => {
    // Large values are read once the rows are listed, so SQLite holds one value at a time, not the listing's and a piece's.
    const large: { id: bigint; size: number; length: number }[] = []
    for (const row of picked.iterate(...parameters)) {
      const { id, size, length, zstd: compressed, small } = PickedSchema.parse(row)
      if (small) {
        valueNames(small, tails, into, compressed === 1n)
        pressure(small.length)
      } else if (id !== null && size !== null && length !== null) large.push({ id, size: Number(size), length: Number(length) })
    }
    if (!piece) return
    for (const { id, size, length } of large) {
      for (let at = 1; at <= length; at += PIECE) {
        const part = PieceSchema.parse(piece.get(at, id)).piece
        const text = Text.safeParse(part)
        if (text.success) namesInText(text.data, tails, into)
        else if (part) namesIn(z.instanceof(Uint8Array).parse(part), tails, into)
        // SQLite held the whole value for this piece.
        pressure(size)
      }
    }
  }
}

function valueNames(value: SQLOutputValue | undefined, tails: readonly Tail[], into: Set<string>, compressed?: boolean): void {
  const text = Text.safeParse(value)
  if (text.success) return namesInText(text.data, tails, into)
  if (!(value instanceof Uint8Array)) return
  const bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  namesIn((compressed ?? bytes.subarray(0, 4).equals(ZSTD_MAGIC)) ? zstdDecompressSync(bytes) : bytes, tails, into)
}

/** A text file in pieces, each read with the end of the one before, so a name across a boundary is found. */
async function textNames(path: string, tails: readonly Tail[], into: Set<string>, pressure: Pressure): Promise<void> {
  let carry = Buffer.alloc(0)
  for await (const piece of createReadStream(path, { highWaterMark: TEXT_PIECE })) {
    const chunk = z.instanceof(Buffer).parse(piece)
    const bytes = carry.length ? Buffer.concat([carry, chunk]) : chunk
    namesIn(bytes, tails, into)
    pressure(bytes.length)
    carry = Buffer.from(bytes.subarray(Math.max(0, bytes.length - OVERLAP)))
  }
}

/**
 * A source's stamp: the size, times and inode of the file and, for SQLite,
 * its write-ahead log; for a LevelDB folder, every file in it. Null when it's
 * gone.
 */
async function stampOf(path: string, kind: SourceKind): Promise<string | null> {
  const part = async (file: string) => {
    const info = await stat(file).catch((error: Error) => {
      if (Gone.safeParse(error).success) return null
      throw error
    })
    return info ? `${info.size}:${info.mtimeMs}:${info.ctimeMs}:${info.ino}` : null
  }
  if (kind === "leveldb" || kind === "chromium") {
    let names: string[]
    try {
      names = (await readdir(path)).sort()
    } catch (error) {
      if (Gone.safeParse(error).success) return null
      throw error
    }
    return (await Promise.all(names.map(async (name) => `${name}=${(await part(join(path, name))) ?? "-"}`))).join("|")
  }
  const own = await part(path)
  if (own === null) return null
  return kind === "text" ? own : `${own}|${(await part(`${path}-wal`)) ?? "-"}`
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '""')}"`
}

function zero(): FilesAndBytes {
  return { files: 0, bytes: 0 }
}

function add(total: FilesAndBytes, bytes: number): void {
  total.files += 1
  total.bytes += bytes
}

function sub(total: FilesAndBytes, bytes: number): void {
  total.files -= 1
  total.bytes -= bytes
}

function emptyFolder(folder: SweptFolder): FolderReport {
  return {
    kind: folder.kind, path: folder.path, files: 0, bytes: 0, named: zero(), held: zero(), young: zero(), reclaimable: zero(), kept: zero(),
    trashed: zero(), restored: 0, deleted: zero(), trash: zero(),
  }
}

function emptyReport(): AttachmentSweepReport {
  return {
    ran: false, swept: false, folders: {}, owners: {}, sources: { total: 0, read: 0, cached: 0, unreadable: 0 },
    unreadable: [], holds: [], ms: 0, yieldedMs: 0, slowest: [],
  }
}

/** Totals over every folder of a report, or of those of one kind. */
export function totals(report: AttachmentSweepReport, kind?: FolderKind): Omit<FolderReport, "kind" | "path"> {
  const sum = { files: 0, bytes: 0, named: zero(), held: zero(), young: zero(), reclaimable: zero(), kept: zero(), trashed: zero(), restored: 0, deleted: zero(), trash: zero() }
  for (const folder of Object.values(report.folders)) {
    if (kind && folder.kind !== kind) continue
    sum.files += folder.files
    sum.bytes += folder.bytes
    sum.restored += folder.restored
    for (const key of ["named", "held", "young", "reclaimable", "kept", "trashed", "deleted", "trash"] as const) {
      sum[key].files += folder[key].files
      sum[key].bytes += folder[key].bytes
    }
  }
  return sum
}

/** Runs `work` on a file; false when the file was already gone, any other failure thrown. */
async function unlessGone(work: Promise<unknown>): Promise<boolean> {
  try {
    await work
    return true
  } catch (error) {
    if (Gone.safeParse(error).success) return false
    throw error
  }
}

