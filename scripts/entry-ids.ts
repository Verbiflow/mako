/**
 * Whether each saved session's entries carry ids taken from their records:
 * every entry has one, no two share one, a second read gives the same, and
 * how many entries say which record they came from. A read that starts
 * mid-file is noted where it names a record otherwise than the whole read:
 * it decodes without the turn before it, so an entry a turn folds several
 * records into (a plan) is named by the first of them it saw. Read-only.
 * Whether ids, and everything else an entry holds, hold across two decoder
 * builds is `scripts/decode-diff.ts`'s (`--base <ref>`).
 *
 *   npx tsx scripts/entry-ids.ts                      12 sessions of each reader, largest first
 *   npx tsx scripts/entry-ids.ts --per 40 --only codex
 */
import { createHash } from "node:crypto"
import { open } from "node:fs/promises"
import { homedir } from "node:os"
import { parseArgs } from "node:util"
import { SessionCatalog, translatorBuild, type SessionProvider } from "@mako/sessions"
import { storeReader } from "./decode-compare"

const { values: options } = parseArgs({
  options: {
    per: { type: "string", default: "12" },
    only: { type: "string" },
    /** Session files past this many bytes are left out, so a run stays quick. */
    "max-bytes": { type: "string", default: String(512 * 1024 * 1024) },
  },
})

const READERS = ["claude", "codex", "cursor", "devin", "devin-ide", "grok", "opencode"]


interface Finding {
  reader: string
  path: string
  entries: number
  missing: number
  repeated: string[]
  recorded: number
  unread: number
  unstable: boolean
  /** Why the session could not be read at all. */
  failed?: string
  tail?: { entries: number; foreign: string[] }
}

const home = homedir()
const translator = translatorBuild()
const findings: Finding[] = []

for (const reader of READERS) {
  if (options.only && options.only !== reader) continue
  const provider = storeReader(reader, home)
  const catalog = new SessionCatalog([provider], { translator, readOnly: true })
  await catalog.scan()
  const sized = catalog.list().map((ref) => ({ path: ref.path, bytes: ref.bytes ?? 0 }))
  await catalog.stop()
  const paths = sized
    // A database session's bytes are its record's position, not a size.
    .filter((session) => session.path.includes("#") || session.bytes <= Number(options["max-bytes"]))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, Number(options.per))
    .map((session) => session.path)
  for (const path of paths) {
    const finding = await check(reader, provider, path)
    if (finding) findings.push(finding)
  }
}

async function check(reader: string, provider: SessionProvider, path: string): Promise<Finding | null> {
  const thread = await provider.read(path).catch((error) => (error instanceof Error ? error : new Error(String(error))))
  if (thread instanceof Error || !thread) {
    return { reader, path, entries: 0, missing: 0, repeated: [], recorded: 0, unread: 0, unstable: false, failed: thread?.message ?? "the reader returned nothing" }
  }
  const ids = thread.entries.map((entry) => entry.id ?? "")
  const seen = new Map<string, number>()
  for (const id of ids) if (id) seen.set(id, (seen.get(id) ?? 0) + 1)
  const again = await provider.read(path).catch(() => null)
  const finding: Finding = {
    reader,
    path,
    entries: ids.length,
    missing: ids.filter((id) => !id).length,
    repeated: [...seen].flatMap(([id, count]) => (count > 1 ? [id] : [])),
    recorded: thread.entries.filter((entry) => entry.record).length,
    unread: thread.entries.filter((entry) => entry.type === "unread").length,
    unstable: digest(again?.entries.map((entry) => entry.id ?? "") ?? []) !== digest(ids),
  }
  if (provider.tail && thread.checkpoint !== undefined && thread.checkpoint > 0) {
    const from = await lineStart(path, Math.floor(thread.checkpoint / 2))
    const tail = from === undefined ? undefined : await provider.tail(path, from).catch(() => undefined)
    // A tail decodes its first turn without the lines before it, so only ids that name a record are compared.
    if (tail) finding.tail = { entries: tail.entries.length, foreign: tail.entries.flatMap((entry) => (entry.record && entry.id && !seen.has(entry.id) ? [entry.id] : [])) }
  }
  return finding
}

/** The first line start at or after `offset`, read from the plain file; undefined for a compressed or missing one. */
async function lineStart(path: string, offset: number): Promise<number | undefined> {
  if (!path.endsWith(".jsonl")) return undefined
  const handle = await open(path, "r").catch(() => null)
  if (!handle) return undefined
  try {
    const buffer = Buffer.alloc(1 << 20)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    const newline = buffer.subarray(0, bytesRead).indexOf(0x0a)
    return newline < 0 ? undefined : offset + newline + 1
  } finally {
    await handle.close()
  }
}

function digest(ids: readonly string[]): string {
  return createHash("sha256").update(ids.join("\n")).digest("base64url")
}

function short(path: string): string {
  const parts = path.replace(home, "~").split("/")
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : parts.join("/")
}

let failed = false
console.log(`${"reader".padEnd(9)} ${"session".padEnd(44)} ${"entries".padStart(8)} ${"recorded".padStart(9)} ${"unread".padStart(7)}  findings`)
for (const finding of findings) {
  const notes: string[] = []
  if (finding.failed) notes.push(`unreadable: ${finding.failed}`)
  if (finding.missing) notes.push(`${finding.missing} without an id`)
  if (finding.repeated.length) notes.push(`${finding.repeated.length} ids repeated (${finding.repeated.slice(0, 3).join(", ")})`)
  if (finding.unstable) notes.push("a second read gave other ids")
  const noted: string[] = []
  if (finding.tail?.foreign.length) noted.push(`tail named ${finding.tail.foreign.length} of ${finding.tail.entries} otherwise (${finding.tail.foreign.slice(0, 2).join(", ")})`)
  if (notes.length) failed = true
  notes.push(...noted)
  const share = finding.entries ? `${Math.round((100 * finding.recorded) / finding.entries)}%` : "-"
  console.log(`${finding.reader.padEnd(9)} ${short(finding.path).padEnd(44)} ${String(finding.entries).padStart(8)} ${share.padStart(9)} ${String(finding.unread).padStart(7)}  ${notes.join("; ") || "ok"}`)
}
process.exitCode = failed ? 1 : 0
