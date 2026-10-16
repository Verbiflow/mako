import { createHash, randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import type { ChildTranscript, ChildTranscripts } from "./children.js"
import { isReplyEntry, type Entry } from "./entries.js"
import type { Thread } from "./format.js"
import { renderTranscriptBundle, type TranscriptChild } from "./transcript.js"

/**
 * Child agents' transcripts for a transcript bundle. A bundle lists the
 * children of each session it carries and links each one's whole
 * transcript, rendered as a bundle of its own by the same renderer from the
 * same reader as any session. A child can be megabytes and a session can
 * start dozens, so each is rendered once into a folder named for where its
 * record is and how big and how new it is, beside the bundles: a later
 * bundle that carries it again only looks at the record's size and time.
 *
 *   <root>/<child>-<stamp>/transcript.md
 *   <root>/<child>-<stamp>/transcript-assets/…   its own sidecars
 *   <root>/<child>-<stamp>/summary.json          what the index needs, so a reused child isn't read
 *
 * A bundle sits in a folder beside `<root>`, so it links a child as
 * `../<root name>/<child>-<stamp>/transcript.md`.
 */

/** What a bundle reads children through: the catalog's listing and its reader. */
export interface ChildSource {
  children(path: string): Promise<ChildTranscripts | null>
  open(path: string): Promise<Thread | null>
}

/** A session whose entries a bundle carries. */
export interface ChildParent {
  path: string
  /** The ids of the calls the bundle carries; a child started by any other call is left out. */
  toolIds: ReadonlySet<string>
  /**
   * The bundle carries the session whole, so every child it started belongs
   * to it, including one whose call the harness didn't record or recorded
   * under another id than the bundle's entries give it.
   */
  whole: boolean
}

export interface BundledChildren {
  children: TranscriptChild[]
  /** Every file of every linked child transcript, for the manifest. */
  files: string[]
  /** How the children were had: rendered now, reused from an earlier bundle, or neither. */
  stats: { listed: number; rendered: number; reused: number; unreadable: number; ms: number }
}

/** Raised when the rendering changes, so every child is rendered again. */
const RENDERING = 5
/** Children rendered at once; each holds one decoded transcript. */
const PARALLEL = 4
/** A child folder no bundle has carried for this long is removed. */
const UNUSED_MS = 30 * 24 * 60 * 60 * 1000
const SWEEP_EVERY_MS = 60 * 60 * 1000

const LastSchema = z.object({
  at: z.string().optional(),
  text: z.string(),
  after: z.object({ calls: z.number().int().nonnegative(), at: z.string().optional(), call: z.string() }).optional(),
})
const SummarySchema = z.object({
  rendering: z.literal(RENDERING),
  entries: z.number().int().nonnegative(),
  characters: z.number().int().nonnegative(),
  files: z.array(z.string()),
  last: LastSchema.optional(),
})
type Summary = z.infer<typeof SummarySchema>

/** The ids of the calls `entries` carry, which pick the children a bundle carries. */
export function toolIdsOf(entries: readonly Entry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of entries) if (entry.type === "tool" && entry.id) ids.add(entry.id)
  return ids
}

/** A child a bundle carries, with the harness whose reader opens it. */
interface CarriedChild {
  child: ChildTranscript
  harness: string
}

/**
 * The children of `parents` a bundle carries: one the session started when
 * the bundle carries the call that started it, or any when it carries the
 * session whole, and every child those started in turn. Listed once each,
 * in the order the parents list them.
 */
async function carriedChildren(source: ChildSource, parents: readonly ChildParent[]): Promise<CarriedChild[]> {
  const carried: CarriedChild[] = []
  const seen = new Set<string>()
  for (const parent of parents) {
    const listed = await source.children(parent.path).catch(() => null)
    if (!listed?.children.length) continue
    const harness = listed.parent.harness
    const kept = new Set<string>()
    for (const child of listed.children)
      if (child.spawnedBy === undefined && (parent.whole || (child.toolId !== undefined && parent.toolIds.has(child.toolId)))) kept.add(child.nativeId)
    // A nested child can be listed before the child that started it.
    for (let grew = true; grew; ) {
      grew = false
      for (const child of listed.children)
        if (child.spawnedBy !== undefined && !kept.has(child.nativeId) && kept.has(child.spawnedBy)) {
          kept.add(child.nativeId)
          grew = true
        }
    }
    for (const child of listed.children) {
      const key = `${harness}\0${child.nativeId}`
      if (!kept.has(child.nativeId) || seen.has(key)) continue
      seen.add(key)
      carried.push({ child, harness })
    }
  }
  return carried
}

export class ChildSidecars {
  private readonly root: string
  private swept = 0

  constructor(root: string) {
    this.root = root
  }

  /**
   * The children of `parents` the bundle carries, each linked to its
   * transcript; a nested child comes with the child that started it. Only
   * children not rendered at their current size and time are read.
   */
  async bundle(source: ChildSource, parents: readonly ChildParent[]): Promise<BundledChildren> {
    const started = performance.now()
    const stats = { listed: 0, rendered: 0, reused: 0, unreadable: 0, ms: 0 }
    const listed = await carriedChildren(source, parents)
    stats.listed = listed.length
    const bundled = new Map<ChildTranscript, TranscriptChild>()
    const files: string[] = []
    // The deepest first: a child's transcript links the children it started.
    const starter = new Map(listed.map((entry) => [entry.child.nativeId, entry.child.spawnedBy]))
    const levels = new Map<number, typeof listed>()
    for (const entry of listed) {
      let depth = 0
      for (let at = entry.child.spawnedBy; at !== undefined && depth < 16; depth++) at = starter.get(at)
      levels.set(depth, [...(levels.get(depth) ?? []), entry])
    }
    for (const level of [...levels.keys()].sort((left, right) => right - left)) {
      const entries = levels.get(level) ?? []
      for (let at = 0; at < entries.length; at += PARALLEL)
        await Promise.all(entries.slice(at, at + PARALLEL).map(async ({ child, harness: childHarness }) => {
          const nested = listed.filter((entry) => entry.child.spawnedBy === child.nativeId).flatMap((entry) => bundled.get(entry.child) ?? [])
          const result = await this.child(source, child, childHarness, nested)
          stats[result.how] += 1
          files.push(...result.files)
          bundled.set(child, result.child)
        }))
    }
    void this.sweep()
    stats.ms = Math.round(performance.now() - started)
    return { children: listed.flatMap((entry) => bundled.get(entry.child) ?? []), files, stats }
  }

  private async child(
    source: ChildSource,
    child: ChildTranscript,
    harness: string,
    nested: readonly TranscriptChild[]
  ): Promise<{ child: TranscriptChild; files: string[]; how: "rendered" | "reused" | "unreadable" }> {
    const bundled = transcriptChild(child, harness)
    if (!child.path) return { child: bundled, files: [], how: "unreadable" }
    const stamp = await sourceStamp(child.path)
    if (stamp === null) return { child: { ...bundled, unreadable: "Its record couldn't be read." }, files: [], how: "unreadable" }
    // Nested children are linked from its transcript, so their folders are part of what it is.
    const digest = createHash("sha256").update(`${RENDERING}\0${stamp}`)
    for (const entry of nested) digest.update("\0").update(entry.transcript?.link ?? entry.nativeId)
    const name = `${createHash("sha256").update(`${harness}\0${child.path}`).digest("hex").slice(0, 16)}-${digest.digest("hex").slice(0, 16)}`
    const folder = join(this.root, name)
    const link = `../${basename(this.root)}/${name}/transcript.md`
    const held = await this.summary(folder)
    if (held) return { child: withSummary(bundled, link, held), files: held.files.map((file) => join(folder, file)), how: "reused" }
    const thread = await source.open(child.path).catch(() => null)
    if (!thread) return { child: { ...bundled, unreadable: "Its harness's reader opened no transcript at its path." }, files: [], how: "unreadable" }
    const rendered = renderTranscriptBundle(thread, {
      from: harness,
      mainBudget: Number.POSITIVE_INFINITY,
      totalBudget: Number.POSITIVE_INFINITY,
      children: nested.map((entry) => (entry.transcript ? { ...entry, transcript: { ...entry.transcript, link: siblingLink(entry.transcript.link) } } : entry)),
    })
    const summary: Summary = {
      rendering: RENDERING,
      entries: thread.entries.length,
      characters: rendered.metadata.totalCharacters,
      files: ["transcript.md", ...rendered.assets.map((asset) => asset.path)],
    }
    const last = lastWords(thread.entries)
    if (last) summary.last = last
    // Written whole beside the folder and moved into place, so a folder that exists is complete.
    const temporary = join(this.root, `.${name}.${randomUUID()}.tmp`)
    try {
      for (const asset of rendered.assets) {
        const file = join(temporary, asset.path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, asset.content, { encoding: asset.encoding ?? "utf8", mode: 0o600 })
      }
      await mkdir(temporary, { recursive: true })
      await writeFile(join(temporary, "transcript.md"), rendered.markdown, { mode: 0o600 })
      await writeFile(join(temporary, "summary.json"), JSON.stringify(summary), { mode: 0o600 })
      await rename(temporary, folder).catch(async (error: NodeJS.ErrnoException) => {
        // Another bundle rendered the same child at the same stamp first; theirs is the same.
        if (error.code !== "ENOTEMPTY" && error.code !== "EEXIST") throw error
        await rm(temporary, { recursive: true, force: true })
      })
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
    return { child: withSummary(bundled, link, summary), files: summary.files.map((file) => join(folder, file)), how: "rendered" }
  }

  /** The file a bundle's link to a child transcript names. */
  file(link: string): string {
    return join(dirname(this.root), link.replace(/^\.\.\//, ""))
  }

  /** A rendered child's summary, marked used; null when it isn't rendered at this stamp. */
  private async summary(folder: string): Promise<Summary | null> {
    const raw = await readFile(join(folder, "summary.json"), "utf8").catch(() => null)
    if (raw === null) return null
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return null
    }
    const summary = SummarySchema.safeParse(parsed).data ?? null
    if (summary) {
      const now = new Date()
      await utimes(join(folder, "summary.json"), now, now).catch(() => undefined)
    }
    return summary
  }

  /** Removes child folders no bundle has carried for `UNUSED_MS`, at most once an hour. */
  private async sweep(): Promise<void> {
    if (Date.now() - this.swept < SWEEP_EVERY_MS) return
    this.swept = Date.now()
    for (const name of await readdir(this.root).catch(() => new Array<string>())) {
      const folder = join(this.root, name)
      const used = (await stat(join(folder, "summary.json")).catch(() => null))?.mtimeMs ?? (await stat(folder).catch(() => null))?.mtimeMs
      if (used !== undefined && Date.now() - used > UNUSED_MS) await rm(folder, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

/**
 * `thread` with each call that started a child agent saying where that
 * child's transcript is, for a conversation written into another harness's
 * own store: there is no bundle there to index its children, and the call's
 * output alone is what the source harness told its own model.
 */
export function withChildReferences(thread: Thread, children: readonly TranscriptChild[], file: (link: string) => string): Thread {
  const byTool = new Map(children.flatMap((child) => (child.toolId ? [[child.toolId, child] as const] : [])))
  if (!byTool.size) return thread
  const entries = thread.entries.map((entry): Entry => {
    const child = entry.type === "tool" ? byTool.get(entry.id) : undefined
    if (!child || entry.type !== "tool") return entry
    const title = child.title === undefined ? "" : ` "${child.title}"`
    const where = child.transcript
      ? `ran in a transcript of its own, at ${file(child.transcript.link)}`
      : child.state.kind === "missing" ? `left no transcript on this Mac: ${child.state.reason}` : "ran in a transcript of its own, which couldn't be rendered"
    const note = `[Mako: child agent${title} (${child.state.kind}) ${where}. It can't be reached from this session.]`
    return { ...entry, output: entry.output ? `${entry.output}\n\n${note}` : note }
  })
  return { ...thread, entries }
}

function transcriptChild(child: ChildTranscript, harness: string): TranscriptChild {
  const bundled: TranscriptChild = { nativeId: child.nativeId, harness, state: child.state }
  if (child.title !== undefined) bundled.title = child.title
  if (child.role !== undefined) bundled.role = child.role
  if (child.model !== undefined) bundled.model = child.model
  if (child.toolId !== undefined) bundled.toolId = child.toolId
  if (child.spawnedBy !== undefined) bundled.spawnedBy = child.spawnedBy
  if (child.startedAt !== undefined) bundled.startedAt = child.startedAt
  if (child.updatedAt !== undefined) bundled.updatedAt = child.updatedAt
  return bundled
}

/** A bundle's link to a child folder (`../<root>/<child>/transcript.md`), as another child folder beside it links it. */
function siblingLink(link: string): string {
  return `../${link.split("/").slice(-2).join("/")}`
}

function withSummary(child: TranscriptChild, link: string, summary: Summary): TranscriptChild {
  const bundled: TranscriptChild = { ...child, transcript: { link, entries: summary.entries, characters: summary.characters } }
  if (summary.last) bundled.last = summary.last
  return bundled
}

/**
 * Where a child's record is now, as its size and time: the file at its path,
 * or the database a `<database>#<id>` path names with its write-ahead log.
 */
async function sourceStamp(path: string): Promise<string | null> {
  const direct = await stat(path).catch(() => null)
  const file = direct ? path : path.slice(0, path.indexOf("#"))
  const info = direct ?? (path.includes("#") ? await stat(file).catch(() => null) : null)
  if (!info) return null
  const wal = await stat(`${file}-wal`).catch(() => null)
  return `${info.size}:${info.mtimeMs}:${wal?.size ?? ""}:${wal?.mtimeMs ?? ""}`
}

/** The longest a call's input is quoted where a child's last activity is told. */
const CALL_INPUT_QUOTED = 200

/**
 * What a child last said: the run of text that ends its last reply with
 * any, which for one that finished is its final answer. A reply begins at
 * an entry that names its model and ends at one that carries its usage. A child can work for an hour after its last
 * words (one a usage limit cut off does), so they come with the calls it
 * made after them and the last of those. One that wrote no text has no
 * words (`text` empty) and its calls, or else its last entry.
 */
export function lastWords(entries: readonly Entry[]): TranscriptChild["last"] {
  let calls = 0
  let lastCall: { at?: string; call: string } | undefined
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!
    if (entry.type === "tool") {
      calls += 1
      lastCall ??= { ...entry.at !== undefined && { at: isoTime(entry.at) }, call: quotedCall(entry.name ?? entry.title ?? "", entry.input) }
      continue
    }
    if (entry.type !== "text" || !entry.text.trim()) continue
    const said = [entry.text]
    let first = entry
    for (let earlier = index - 1; earlier >= 0; earlier--) {
      const before = entries[earlier]!
      if (first.model !== undefined || (isReplyEntry(before) && before.usage)) break
      if (before.type === "text" && before.text.trim()) {
        said.unshift(before.text)
        first = before
      } else if (before.type !== "thinking" && before.type !== "attachment") break
    }
    const words: NonNullable<TranscriptChild["last"]> = first.at === undefined ? { text: said.join("\n\n") } : { at: isoTime(first.at), text: said.join("\n\n") }
    if (lastCall) words.after = { calls, ...lastCall }
    return words
  }
  if (lastCall) return { text: "", after: { calls, ...lastCall } }
  const entry = entries.at(-1)
  if (!entry) return undefined
  const text = entry.type === "event" ? [entry.label, entry.detail].filter(Boolean).join(": ") : entry.type === "user" && entry.text ? `Was sent: ${entry.text}` : ""
  if (!text) return undefined
  return entry.at === undefined ? { text } : { at: isoTime(entry.at), text }
}

function isoTime(at: number): string {
  return new Date(at).toISOString()
}

function quotedCall(name: string, input: string | undefined): string {
  const flat = (input ?? "").replace(/\s+/g, " ").trim()
  if (!flat) return name
  return `${name} ${flat.length > CALL_INPUT_QUOTED ? `${flat.slice(0, CALL_INPUT_QUOTED)}…` : flat}`
}
