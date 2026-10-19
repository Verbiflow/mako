/**
 * What a decoder change does to the person's own sessions: two builds of
 * `@mako/sessions` decode the same records, and every entry that draws
 * differently is listed, with which of its fields changed, beside the
 * unread record kinds that became read (or new ones that appeared). The
 * loop when a harness ships a release: re-record the fixtures on the new
 * version (`bump-harness-versions.ts`), fix the decoder, run this against
 * the build before the fix, ship; views then rebuild under the new build.
 * Read-only for the harnesses: each build reads the stores through a
 * read-only catalog, in memory.
 *
 *   npx tsx scripts/decode-diff.ts --base HEAD                 this checkout against HEAD's build, on the newest 100 sessions
 *   npx tsx scripts/decode-diff.ts --base HEAD --only codex --per 40
 *   npx tsx scripts/decode-diff.ts --save before.json          keep this build's decode (ids, types, a digest per field, unread kinds)
 *   npx tsx scripts/decode-diff.ts --against before.json       this build against a kept one, on the same sessions
 *   npx tsx scripts/decode-diff.ts --base HEAD --show <path>   one session's differing entries, both builds' JSON side by side
 *   npx tsx scripts/decode-diff.ts ... --json <file>           the comparison as JSON
 *
 * `--base <ref>` builds `<ref>`'s `packages/sessions` in a temporary git
 * worktree beside this checkout (its `node_modules` linked, nothing
 * installed), decodes with it, then with this checkout's build, and removes
 * the worktree. Entries are matched by id, which comes from the record
 * (`entries.ts`), so two builds name the same entry the same way.
 */
import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"
import { parseArgs } from "node:util"
import { z } from "zod"
import type { Entry, SessionCatalog, Thread, ThreadRef, UnreadRecord } from "@mako/sessions"

const run = promisify(execFile)
const REPO = resolve(import.meta.dirname, "..")

const { values: options } = parseArgs({
  options: {
    base: { type: "string" },
    save: { type: "string" },
    against: { type: "string" },
    dist: { type: "string" },
    per: { type: "string", default: "100" },
    only: { type: "string" },
    "max-mib": { type: "string", default: "512" },
    show: { type: "string" },
    json: { type: "string" },
  },
})

/** One entry as a run keeps it: enough to tell that it, and which of its fields, changed. */
const KeptEntrySchema = z.object({ id: z.string(), type: z.string(), digest: z.string(), fields: z.record(z.string(), z.string()) })
type KeptEntry = z.infer<typeof KeptEntrySchema>
const KeptUnreadSchema = z.object({ kind: z.string(), reason: z.string(), count: z.number() })
const KeptSessionSchema = z.object({
  harness: z.string(), nativeId: z.string(), bytes: z.number(), ms: z.number(),
  entries: z.array(KeptEntrySchema), unread: z.array(KeptUnreadSchema), failed: z.string().optional(),
})
type KeptSession = z.infer<typeof KeptSessionSchema>
const KeptRunSchema = z.object({ translator: z.string(), at: z.string(), sessions: z.record(z.string(), KeptSessionSchema) })
type KeptRun = z.infer<typeof KeptRunSchema>

/** The parts of a `@mako/sessions` build this reads, as its compiled `index.js` exports them. */
interface SessionsBuild {
  defaultCatalog(options: { readOnly: boolean; translator?: string }): SessionCatalog
  translatorBuild(): string
}

const SessionsBuildSchema = z.object({ defaultCatalog: z.function(), translatorBuild: z.function() })

async function loadBuild(dist: string): Promise<SessionsBuild> {
  const loaded: unknown = await import(pathToFileURL(join(dist, "index.js")).href)
  SessionsBuildSchema.parse(loaded)
  // SAFETY: the module is a `@mako/sessions` build, whose index exports both functions with these signatures; the schema checked they're there.
  return loaded as SessionsBuild
}

/** A short hash of a value's JSON. */
const digest = (json: string | undefined) => createHash("sha256").update(json ?? "").digest("base64url").slice(0, 16)

function kept(entry: Entry, index: number): KeptEntry {
  const fields = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== "id").map(([key, value]) => [key, digest(JSON.stringify(value))]))
  return { id: entry.id ?? `#${index}`, type: entry.type, digest: digest(JSON.stringify(entry)), fields }
}

function unreadOf(thread: Thread): KeptSession["unread"] {
  return (thread.unread ?? []).filter((record: UnreadRecord) => record.reason !== "undrawn").map((record) => ({ kind: record.kind, reason: record.reason, count: record.count }))
}

/** The sessions to compare: the newest `per` of each harness asked for (or of all), as this build's catalog lists them, past none it can't read whole quickly. */
function chosen(refs: readonly ThreadRef[]): ThreadRef[] {
  const max = Number(options["max-mib"]) * 1024 * 1024
  return refs
    .filter((ref) => !ref.archived && !ref.childOf && (!options.only || ref.harness === options.only))
    .filter((ref) => ref.path.includes("#") || (ref.bytes ?? 0) <= max)
    .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
    .slice(0, Number(options.per))
}

/** Decodes `paths` (or the newest sessions) with `build`; keeps the whole entries of `whole` for `--show`. */
async function decode(build: SessionsBuild, paths: readonly string[] | null, whole?: string): Promise<{ run: KeptRun; shown?: Entry[]; ms: number }> {
  const translator = build.translatorBuild()
  const catalog = build.defaultCatalog({ readOnly: true, translator })
  const started = performance.now()
  try {
    await catalog.scan()
    const listed = new Map(catalog.list().map((ref) => [ref.path, ref]))
    const targets = paths ? paths.flatMap((path) => listed.get(path) ?? []) : chosen([...listed.values()])
    const run: KeptRun = { translator, at: new Date().toISOString(), sessions: {} }
    let shown: Entry[] | undefined
    for (const ref of targets) {
      const began = performance.now()
      try {
        const thread = await catalog.open(ref.path, false)
        if (!thread) throw new Error("the reader read nothing")
        if (ref.path === whole) shown = thread.entries
        run.sessions[ref.path] = { harness: ref.harness, nativeId: ref.nativeId, bytes: ref.bytes ?? 0, ms: Math.round(performance.now() - began), entries: thread.entries.map(kept), unread: unreadOf(thread) }
      } catch (error) {
        run.sessions[ref.path] = { harness: ref.harness, nativeId: ref.nativeId, bytes: ref.bytes ?? 0, ms: Math.round(performance.now() - began), entries: [], unread: [], failed: error instanceof Error ? error.message : String(error) }
      }
    }
    return { run, ms: Math.round(performance.now() - started), ...shown && { shown } }
  } finally {
    await catalog.stop()
  }
}

/** How one session draws under the new build against the old. */
interface SessionDiff {
  path: string
  harness: string
  entries: number
  /** Same id, other content: the entry's type and the fields that changed. */
  changed: { id: string; type: string; fields: string[] }[]
  added: { id: string; type: string }[]
  gone: { id: string; type: string }[]
  /** Entries both hold, in another order. */
  moved: number
  /** Unread kinds the new build reads now (fewer of them, or none), and ones it doesn't that the old did read. */
  nowRead: { kind: string; reason: string; was: number; now: number }[]
  newlyUnread: { kind: string; reason: string; was: number; now: number }[]
  failed?: { before?: string; after?: string }
}

function compare(path: string, before: KeptSession, after: KeptSession): SessionDiff {
  const old = new Map(before.entries.map((entry) => [entry.id, entry]))
  const now = new Map(after.entries.map((entry) => [entry.id, entry]))
  const changed: SessionDiff["changed"] = []
  for (const entry of after.entries) {
    const was = old.get(entry.id)
    if (!was || was.digest === entry.digest) continue
    const keys = new Set([...Object.keys(was.fields), ...Object.keys(entry.fields)])
    changed.push({ id: entry.id, type: entry.type, fields: [...keys].filter((key) => was.fields[key] !== entry.fields[key]).sort() })
  }
  const shared = after.entries.filter((entry) => old.has(entry.id)).map((entry) => entry.id)
  const order = before.entries.filter((entry) => now.has(entry.id)).map((entry) => entry.id)
  const unread = (list: KeptSession["unread"]) => new Map(list.map((record) => [`${record.kind}\0${record.reason}`, record]))
  const wasUnread = unread(before.unread)
  const nowUnread = unread(after.unread)
  const nowRead: SessionDiff["nowRead"] = []
  const newlyUnread: SessionDiff["newlyUnread"] = []
  for (const [key, record] of wasUnread) {
    const count = nowUnread.get(key)?.count ?? 0
    if (count < record.count) nowRead.push({ kind: record.kind, reason: record.reason, was: record.count, now: count })
  }
  for (const [key, record] of nowUnread) {
    const count = wasUnread.get(key)?.count ?? 0
    if (record.count > count) newlyUnread.push({ kind: record.kind, reason: record.reason, was: count, now: record.count })
  }
  const diff: SessionDiff = {
    path, harness: after.harness, entries: after.entries.length, changed,
    added: after.entries.filter((entry) => !old.has(entry.id)).map(({ id, type }) => ({ id, type })),
    gone: before.entries.filter((entry) => !now.has(entry.id)).map(({ id, type }) => ({ id, type })),
    moved: shared.filter((id, index) => order[index] !== id).length,
    nowRead, newlyUnread,
  }
  if (before.failed || after.failed) diff.failed = { ...before.failed && { before: before.failed }, ...after.failed && { after: after.failed } }
  return diff
}

const quiet = (diff: SessionDiff) => !diff.changed.length && !diff.added.length && !diff.gone.length && !diff.moved && !diff.nowRead.length && !diff.newlyUnread.length && !diff.failed

function short(path: string): string {
  const parts = path.replace(homedir(), "~").split("/")
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : parts.join("/")
}

/** `n kind` with its count, most first. */
function tally(items: readonly { type: string }[]): string {
  const counts = new Map<string, number>()
  for (const item of items) counts.set(item.type, (counts.get(item.type) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1]).map(([type, count]) => `${count} ${type}`).join(", ")
}

function report(before: KeptRun, after: KeptRun, diffs: readonly SessionDiff[], timing: { before?: number; after: number }): string {
  const lines = [`decode diff · ${diffs.length} session${diffs.length === 1 ? "" : "s"} · build ${before.translator} → ${after.translator}${timing.before !== undefined ? ` · decoded in ${(timing.before / 1000).toFixed(1)} s and ${(timing.after / 1000).toFixed(1)} s` : ` · decoded in ${(timing.after / 1000).toFixed(1)} s`}`]
  if (before.translator === after.translator) lines.push("  the two builds are the same: nothing can differ")
  const byHarness = new Map<string, SessionDiff[]>()
  for (const diff of diffs) byHarness.set(diff.harness, [...(byHarness.get(diff.harness) ?? []), diff])
  for (const [harness, list] of [...byHarness].sort(([a], [b]) => a.localeCompare(b))) {
    const differing = list.filter((diff) => !quiet(diff))
    const changed = list.reduce((sum, diff) => sum + diff.changed.length + diff.added.length + diff.gone.length, 0)
    lines.push("", `${harness}  ${differing.length} of ${list.length} session${list.length === 1 ? "" : "s"} draw differently${changed ? `, ${changed} entr${changed === 1 ? "y" : "ies"} in all` : ""}`)
    for (const diff of differing) {
      const parts: string[] = []
      if (diff.changed.length) {
        const fields = new Map<string, number>()
        for (const each of diff.changed) for (const field of each.fields) fields.set(`${each.type}.${field}`, (fields.get(`${each.type}.${field}`) ?? 0) + 1)
        parts.push(`${diff.changed.length} changed (${[...fields].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([field, count]) => `${field} ×${count}`).join(", ")})`)
      }
      if (diff.added.length) parts.push(`${diff.added.length} added (${tally(diff.added)})`)
      if (diff.gone.length) parts.push(`${diff.gone.length} gone (${tally(diff.gone)})`)
      if (diff.moved) parts.push(`${diff.moved} in another order`)
      if (diff.failed) parts.push(`failed ${diff.failed.before ? `before: ${diff.failed.before}` : ""}${diff.failed.after ? ` after: ${diff.failed.after}` : ""}`.trim())
      lines.push(`  ${short(diff.path).padEnd(48)} ${parts.join(" · ") || "unread kinds only"}`)
      for (const read of diff.nowRead) lines.push(`    now read: ${read.kind} (${read.reason}) ${read.was} → ${read.now}`)
      for (const unread of diff.newlyUnread) lines.push(`    newly unread: ${unread.kind} (${unread.reason}) ${unread.was} → ${unread.now}`)
    }
  }
  const nowRead = diffs.reduce((sum, diff) => sum + diff.nowRead.reduce((each, read) => each + read.was - read.now, 0), 0)
  const newly = diffs.reduce((sum, diff) => sum + diff.newlyUnread.reduce((each, unread) => each + unread.now - unread.was, 0), 0)
  lines.push("", `unread records: ${nowRead} now read, ${newly} newly unread`)
  return lines.join("\n")
}

/** Builds `ref`'s `packages/sessions` in a temporary worktree and returns its `dist` and how to remove it. */
async function baseBuild(ref: string): Promise<{ dist: string; remove: () => Promise<void> }> {
  const folder = await mkdtemp(join(tmpdir(), "mako-decode-base-"))
  const tree = join(folder, "checkout")
  await run("git", ["-C", REPO, "worktree", "add", "--detach", tree, ref])
  const remove = async () => {
    await run("git", ["-C", REPO, "worktree", "remove", "--force", tree]).catch(() => undefined)
    await rm(folder, { recursive: true, force: true })
  }
  try {
    await symlink(join(REPO, "node_modules"), join(tree, "node_modules"), "dir")
    await run(join(REPO, "node_modules", ".bin", "tsgo"), ["-b", "."], { cwd: join(tree, "packages", "sessions") })
    return { dist: join(tree, "packages", "sessions", "dist"), remove }
  } catch (error) {
    await remove()
    throw error
  }
}

const current = await loadBuild(resolve(options.dist ?? join(REPO, "packages", "sessions", "dist")))

if (options.save && !options.base) {
  const { run: saved, ms } = await decode(current, null)
  await writeFile(options.save, JSON.stringify(saved))
  console.log(`Kept ${Object.keys(saved.sessions).length} sessions decoded by build ${saved.translator} in ${(ms / 1000).toFixed(1)} s: ${options.save}`)
} else if (options.against || options.base) {
  let before: KeptRun
  let beforeMs: number | undefined
  let shownBefore: Entry[] | undefined
  let removeBase: (() => Promise<void>) | undefined
  let after: KeptRun
  let afterMs: number
  let shownAfter: Entry[] | undefined
  try {
    if (options.base) {
      // This build chooses the sessions; the base decodes the same ones.
      const listing = await decode(current, null, options.show)
      after = listing.run
      afterMs = listing.ms
      shownAfter = listing.shown
      const base = await baseBuild(options.base)
      removeBase = base.remove
      const decoded = await decode(await loadBuild(base.dist), Object.keys(after.sessions), options.show)
      before = decoded.run
      beforeMs = decoded.ms
      shownBefore = decoded.shown
      if (options.save) await writeFile(options.save, JSON.stringify(before))
    } else {
      if (!options.against || !existsSync(options.against)) throw new Error(`No kept run at ${options.against}`)
      before = KeptRunSchema.parse(JSON.parse(await readFile(options.against, "utf8")))
      const decoded = await decode(current, Object.keys(before.sessions), options.show)
      after = decoded.run
      afterMs = decoded.ms
      shownAfter = decoded.shown
    }
  } finally {
    await removeBase?.()
  }
  const diffs = Object.entries(after.sessions).flatMap(([path, session]) => {
    const was = before.sessions[path]
    return was ? [compare(path, was, session)] : []
  })
  console.log(report(before, after, diffs, { ...beforeMs !== undefined && { before: beforeMs }, after: afterMs }))
  if (options.show) {
    const diff = diffs.find((each) => each.path === options.show)
    const ids = new Set([...diff?.changed.map((each) => each.id) ?? [], ...diff?.added.map((each) => each.id) ?? [], ...diff?.gone.map((each) => each.id) ?? []])
    for (const id of ids) {
      console.log(`\n${id}`)
      console.log(`  before: ${JSON.stringify(shownBefore?.find((entry) => entry.id === id) ?? null)}`)
      console.log(`  after:  ${JSON.stringify(shownAfter?.find((entry) => entry.id === id) ?? null)}`)
    }
    if (!shownBefore) console.log("\n(the kept run holds no entries whole; --base decodes both builds and shows them)")
  }
  if (options.json) await writeFile(options.json, JSON.stringify({ before: before.translator, after: after.translator, diffs }, null, 2))
} else {
  console.error("decode-diff takes --base <ref>, --save <file> or --against <file>; see the top of scripts/decode-diff.ts")
  process.exitCode = 2
}
