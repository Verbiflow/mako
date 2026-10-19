import { z } from "zod"
import type { RecordRow, RecordValue } from "./harness-records.js"
import { compareVersions } from "./runtime-version.js"

/**
 * Which build of a harness wrote a session's records, kept with each
 * version the record store captures (`RecordStore`), and the one rule every
 * native restore follows with it: records go only into the same version of
 * their harness or a newer one (`restoreGate`).
 *
 * A version comes from one of two places, and says which:
 * - `record`: the harness's own records state it. Claude Code puts its
 *   version on every transcript line, Codex `cli_version` in a rollout's
 *   `session_meta` and its `threads` row, OpenCode `version` in a session's
 *   row. Each provider declares where (`SessionRecords.writer`).
 * - `observed`: the records say nothing (Grok, Devin, Cursor), so it's the
 *   version Mako saw run the session as the records were captured: the
 *   live driver's handshake, which each launch's stream keeps as a
 *   `runtime` line, or, for a write Mako heard as it landed, the installed
 *   version the host read off the binary that's still there unchanged
 *   (`observedInstall` in `record-observed.ts`), when every installation of
 *   the harness agrees.
 *
 * No imports but zod and the version order, so the host's contracts and the
 * window read the same types and the same gate.
 *
 * Where neither says, a session written outside Mako (a Devin, `cursor-agent`
 * or Grok session the backfill reached) gets the evidence its harness leaves
 * beside its store (`WriterEvidence`, `record-evidence.ts`): `log`, a log line
 * that names the session and the version of the process that wrote it;
 * `install`, when every install of the harness at every moment the session
 * was written was the same one version; or a `range` whose upper bound is the
 * newest version that could have written it. Nothing is ever guessed: what
 * none of these says stays `unknown`.
 */

/** Where a writer version is known from: its records, Mako seeing it run, a log line naming the session, or the only install there was while it was written. */
export const WriterSourceSchema = z.enum(["record", "observed", "log", "install"])
export type WriterSource = z.infer<typeof WriterSourceSchema>

export const RecordWriterSchema = z.object({ version: z.string(), source: WriterSourceSchema })
export type RecordWriter = z.infer<typeof RecordWriterSchema>

/**
 * What a harness leaves beside its store about which build wrote a session
 * whose records state none and that Mako never saw run: read once by the
 * backfill's pass (`fillWriters`), never guessed.
 */
export const WriterEvidenceSchema = z.object({
  /** `log` and `install` name versions; `range` bounds them; `unknown` found nothing that does. */
  source: z.enum(["log", "install", "range", "unknown"]),
  versions: z.array(z.string()).optional(),
  /** For a `range`: the newest version that could have written the session, and the oldest where known. */
  upTo: z.string().optional(),
  from: z.string().optional(),
  /**
   * What sets a range's upper bound: `build-day`, a harness that names each
   * build by the day it was made (`cursor-agent`); `releases`, the newest
   * release its vendor had published by the last write (`record-releases.ts`);
   * `pins`, the newest version Mako's repository pinned by then, for Mako's
   * own sessions of a runtime it bundles (`record-pins.ts`).
   */
  bound: z.enum(["build-day", "releases", "pins"]).optional(),
  /** Which rules looked (`EVIDENCE_RULES`): evidence an earlier pass found nothing in is looked at again once they learn more. */
  rules: z.number().optional(),
  /** When the session was first and last written, as its store says: what an install must predate to be provably new enough. */
  writes: z.object({ first: z.number(), last: z.number() }).optional(),
  /**
   * The program whose versions these are, where it isn't the one Mako runs
   * the harness's sessions with: `cursor-agent` for a store it wrote, whose
   * builds are numbered by day, not as the Cursor SDK is.
   */
  line: z.string().optional(),
  /** In words, for diagnostics: which file or folder said so. */
  why: z.string(),
  at: z.number(),
})
export type WriterEvidence = z.infer<typeof WriterEvidenceSchema>

/** The evidence rules' version: 2 added release timelines, Mako's pins and Devin.app's launch logs. */
export const EVIDENCE_RULES = 2

/** Every version that wrote a session, by where each is known from, oldest first as they were captured, and the evidence beside the store where neither says. */
export const SessionWritersSchema = z.object({
  record: z.array(z.string()),
  observed: z.array(z.string()),
  evidence: WriterEvidenceSchema.optional(),
})
export type SessionWriters = z.infer<typeof SessionWritersSchema>

/** What a version a capture takes adds to what's known of a file's writers: fed its bytes, it gives the versions they state, in the order they first appear. */
export interface WriterScan {
  push(bytes: Buffer): void
  end(): string[]
}

/**
 * Where a harness's own records state the build that wrote them
 * (`SessionRecords.writer`). Unset where they state none: the store then
 * keeps the version it observed, if any.
 */
export interface RecordWriterRule {
  /** For a file of the session, by its unit key: a scan of the bytes a version adds, or null for a file that states none. */
  file?(key: string): WriterScan | null
  /** For a row of the session: the version its own columns state, or null. `table` is its table's name. */
  row?(table: string, row: RecordRow): string | null
  /**
   * The version the host reads off the harness's installed binary is the
   * version that writes this store, so a write heard as it lands is
   * stamped with it (`observedInstall`). Left out where the store's writer
   * is another build than the CLI Settings reads: Mako's Cursor sessions
   * are written by the SDK it bundles, not by `cursor-agent`.
   */
  installed?: true
}

/** A version a record may state: digits and dots, then a prerelease or build, at most 64 characters. */
const VersionSchema = z.string().max(64).regex(/^\d+(?:\.\d+)+(?:[-+.][\w.+-]*)?$/)

/** The version a record's field states, or null for anything else it holds. */
export function statedVersion(value: RecordValue | undefined): string | null {
  const parsed = VersionSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * A scan for a JSON field whose raw text, `"name":"<version>"`, can't occur
 * inside a JSON string, where its quotes are escaped. `marker` is the text
 * around the value it looks for; `pattern` is matched on the bytes around
 * each place `marker` is found and gives the version as its first group.
 * Bytes are searched, never parsed, so a scan costs about a `Buffer.indexOf`
 * over what a capture took; a match a chunk boundary cut is found again in
 * the next chunk's overlap.
 */
export function fieldScan(marker: string, pattern: RegExp, reach: { before: number; after: number }): () => WriterScan {
  return () => {
    // Made when a scan starts, never as the module loads: the window imports this module's types and gate, and has no `Buffer`.
    const needle = Buffer.from(marker)
    const overlap = reach.before + needle.length + reach.after
    const found: string[] = []
    let carry: Buffer = Buffer.alloc(0)
    const search = (bytes: Buffer) => {
      for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + needle.length)) {
        const around = bytes.toString("latin1", Math.max(0, at - reach.before), Math.min(bytes.length, at + needle.length + reach.after))
        const version = statedVersion(pattern.exec(around)?.[1])
        if (version !== null && !found.includes(version)) found.push(version)
      }
    }
    return {
      push(bytes) {
        const joined = carry.length ? Buffer.concat([carry, bytes]) : bytes
        search(joined)
        carry = Buffer.from(joined.subarray(Math.max(0, joined.length - overlap)))
      },
      end() {
        return found
      },
    }
  }
}

/** The stream line a driver writes once its harness reports its version (`NativeStream.runtime`): `{"at":"…","runtime":"<version>",…}`. */
export const STREAM_RUNTIME_SCAN = fieldScan('","runtime":"', /^\{"at":"[^"]{10,40}","runtime":"([^"]{1,64})"/m, { before: 48, after: 72 })

/** Every version a session's writers name, newest last by `compareVersions`. */
export function writersOf(writers: SessionWriters | null | undefined): RecordWriter[] {
  if (!writers) return []
  const all = new Map<string, RecordWriter>()
  const evidence = writers.evidence
  if (evidence && (evidence.source === "log" || evidence.source === "install")) for (const version of evidence.versions ?? []) all.set(version, { version, source: evidence.source })
  for (const version of writers.observed) all.set(version, { version, source: "observed" })
  // A version the records state is known from them, whatever else saw it run.
  for (const version of writers.record) all.set(version, { version, source: "record" })
  return [...all.values()].sort((a, b) => compareVersions(a.version, b.version))
}

/** The newest version that wrote a session's records, or null when none is known. */
export function newestWriter(writers: SessionWriters | null | undefined): RecordWriter | null {
  return writersOf(writers).at(-1) ?? null
}

/** `writers` with each of `added` taken in, each list keeping the order versions first came in. */
export function mergeWriters(writers: SessionWriters | null, added: { record?: readonly string[]; observed?: readonly string[] }): SessionWriters {
  const next: SessionWriters = { record: [...writers?.record ?? []], observed: [...writers?.observed ?? []], ...writers?.evidence && { evidence: writers.evidence } }
  for (const version of added.record ?? []) if (!next.record.includes(version)) next.record.push(version)
  for (const version of added.observed ?? []) if (!next.observed.includes(version)) next.observed.push(version)
  return next
}

/**
 * The install a restore goes into: its version, and, where the host read it
 * off a binary it can stat, when that binary was put there and whether it's
 * the only install of its harness the host reads.
 */
const InstallSchema = z.object({
  version: z.string(),
  /** When the binary that version was read off was installed (its mtime), unchanged since. */
  since: z.number().optional(),
  /** It's the only install of its harness the host reads, so nothing else ran the session here. */
  sole: z.boolean().optional(),
  /**
   * Who reads the records here when it isn't the program they're of, in
   * words that say where `version` comes from: Mako's bundled Cursor SDK
   * imports `cursor-agent`'s stores and is placed in `cursor-agent`'s
   * numbering by the day its release was published ("Mako's Cursor SDK
   * 1.0.31, published 2026.09.03").
   */
  reader: z.string().optional(),
})
/** An install, and what reads the records of other programs of the harness (`WriterEvidence.line`): `cursor-agent`'s, which the Cursor SDK imports. */
export const InstalledReadingSchema = InstallSchema.extend({ lines: z.record(z.string(), InstallSchema).optional() })
export type InstalledReading = z.infer<typeof InstalledReadingSchema>

/**
 * Whether a session's records may go into a harness whose installed build
 * is `installed`: the one rule for every native restore, the kept
 * session's, a move's and a divergent one's alike. Records go only into the
 * same version or a newer one, since an older build may not read what a
 * newer one wrote.
 *
 * - A known writer (from the records, Mako, a log or the only install there
 *   was): the install must be at least as new.
 * - A range: the install must be at least its upper bound, the newest
 *   version that could have written the session.
 * - Nothing known (a session written outside Mako that left no evidence, or
 *   one the backfill hasn't looked at yet): only an install provably at least
 *   as new as anything that could have written it is allowed, the only
 *   install there is, put there before the session's first write and
 *   unchanged since. Anything else is `unproven`, and gated.
 * - An install whose version can't be read blocks nothing.
 */
export type RestoreGate =
  | { kind: "same-or-newer"; wrote?: RecordWriter; installed: string; why: "writer" | "range" | "install predates the session" }
  | { kind: "older"; wrote: RecordWriter; installed: string; line?: string; reader?: string }
  /** `installed` null: the program the records are of (`line`) isn't installed here. */
  | { kind: "unproven"; installed: string | null; line?: string; reader?: string; upTo?: string; evidence: "range" | "unknown" }
  | { kind: "unknown"; missing: "installed"; wrote?: RecordWriter }

/** An install as a restore is given it: a version alone, or a whole reading. */
const GivenInstallSchema = z.union([z.string().transform((version): InstalledReading => ({ version })), InstalledReadingSchema]).nullable()

export function restoreGate(writers: SessionWriters | null | undefined, installed: string | InstalledReading | null | undefined): RestoreGate {
  const wrote = newestWriter(writers)
  const given = GivenInstallSchema.parse(installed ?? null)
  const line = writers?.evidence?.line
  // Another program's records go only into that program, compared in its own numbering; one not installed here can't be shown to read them.
  if (line !== undefined && given) {
    const other = given.lines?.[line]
    if (!other) return { kind: "unproven", installed: null, line, ...writers?.evidence?.upTo && { upTo: writers.evidence.upTo }, evidence: writers?.evidence?.source === "range" ? "range" : "unknown" }
  }
  const reading = line !== undefined && given ? given.lines?.[line] : given
  if (!reading || statedVersion(reading.version.trim().replace(/^v/i, "")) === null) return wrote ? { kind: "unknown", missing: "installed", wrote } : { kind: "unknown", missing: "installed" }
  const version = reading.version
  const program = { ...line !== undefined && { line }, ...reading.reader !== undefined && { reader: reading.reader } }
  if (wrote)
    return compareVersions(version, wrote.version) >= 0 ? { kind: "same-or-newer", wrote, installed: version, why: "writer" } : { kind: "older", wrote, installed: version, ...program }
  const evidence = writers?.evidence
  if (evidence?.source === "range" && evidence.upTo !== undefined && compareVersions(version, evidence.upTo) >= 0) return { kind: "same-or-newer", installed: version, why: "range" }
  const first = evidence?.writes?.first
  if (reading.sole && reading.since !== undefined && first !== undefined && reading.since <= first) return { kind: "same-or-newer", installed: version, why: "install predates the session" }
  return evidence?.source === "range" && evidence.upTo !== undefined
    ? { kind: "unproven", installed: version, ...program, upTo: evidence.upTo, evidence: "range" }
    : { kind: "unproven", installed: version, ...program, evidence: "unknown" }
}

/** The install a restore refused, as the restore's report and its caller carry it: the version that wrote the records, or the newest that could have, or neither when nothing says. */
export const OutdatedRuntimeSchema = z.object({
  wrote: RecordWriterSchema.optional(),
  upTo: z.string().optional(),
  /** Null: the program the records are of isn't installed here at all. */
  installed: z.string().nullable(),
  /** The program the records are of, where it isn't the one Mako runs (`WriterEvidence.line`). */
  line: z.string().optional(),
  /** What reads them here when it isn't that program, `installed` being its place in the program's numbering (`InstalledReading.reader`). */
  reader: z.string().optional(),
})
export type OutdatedRuntime = z.infer<typeof OutdatedRuntimeSchema>

/** What a refused gate becomes in a restore's report, or null when the restore may go ahead. */
export function outdatedOf(gate: RestoreGate): OutdatedRuntime | null {
  if (gate.kind !== "older" && gate.kind !== "unproven") return null
  const program = { ...gate.line !== undefined && { line: gate.line }, ...gate.reader !== undefined && { reader: gate.reader } }
  if (gate.kind === "older") return { wrote: gate.wrote, installed: gate.installed, ...program }
  return { installed: gate.installed, ...gate.upTo !== undefined && { upTo: gate.upTo }, ...program }
}

/** The sentence a refused restore gets wherever it's said, honest about what Mako can't tell. */
export function outdatedText(label: string, outdated: OutdatedRuntime): string {
  const program = outdated.line ?? label
  if (outdated.reader !== undefined) {
    const reads = `${outdated.reader}, may not read it`
    if (outdated.wrote) return `${program} ${outdated.wrote.version} wrote this session, and ${reads}.`
    if (outdated.upTo) return `Mako can't tell which ${program} version wrote this session; it may have been as new as ${outdated.upTo}, and ${reads}.`
    return `Mako can't tell which ${program} version wrote this session, and ${reads}.`
  }
  const here = outdated.installed === null ? `no ${program} is installed here` : `this Mac has ${program} ${outdated.installed}`
  if (outdated.wrote) return `${program} ${outdated.wrote.version} wrote this session, and ${here}, which may not read it.`
  if (outdated.upTo) return `Mako can't tell which ${program} version wrote this session; it may have been as new as ${outdated.upTo}, and ${here}.`
  return outdated.installed === null
    ? `Mako can't tell which ${program} version wrote this session, and ${here}.`
    : `Mako can't tell which ${program} version wrote this session, so it can't show that ${program} ${outdated.installed} here reads it.`
}
