import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hasVocabulary, isDeclaredTool } from "@mako/sessions/tool-identity"
import type { JsonValue } from "../contracts/json.js"
import type { LiveUpdate } from "@mako/sessions/live-content"
import type { RecordRef } from "@mako/sessions/entries"
import { hostLog } from "./host-log.js"
import { nativeDiagnosticJson } from "./native-diagnostic-json.js"
import { topic } from "./topic.js"

/**
 * Native records no decoder has a meaning for, kept so a new provider event
 * can be read and decided on instead of guessed at from its name.
 *
 * Decoders publish what they could not read; the host's `NativeUnknown`
 * writes the first record of each harness, version and kind per host life
 * whole (up to `MAX_SAMPLE` characters) to `native-unknown.jsonl` beside the
 * host log, with the harness version the live driver's handshake reported
 * and the stream line it came in (`frameOf`), and counts later ones. The
 * file rotates like the host log. It holds conversation content, as the
 * provider's own store does, so it stays on this machine; bearer tokens and
 * `token=` values are scrubbed. What saved readers couldn't read is counted
 * apart, by the version that wrote each record (`@mako/sessions/unread-index`).
 */
export const NATIVE_UNKNOWN_FILE = "native-unknown.jsonl"
const MAX_SAMPLE = 16 * 1024
const MAX_BYTES = 2 * 1024 * 1024
const MAX_KINDS = 1024

export type UnknownReason = "unknown" | "unreadable"

export interface UnknownKind {
  harness: string
  /** The harness version the launch reported; absent before its handshake, or when it reports none. */
  version?: string
  kind: string
  reason: UnknownReason
  count: number
  firstSeen: number
  /** When the newest came, and the stream line it came in, which Show original opens. */
  newest: { at: number; frame?: RecordRef }
}

/** Where an unknown record was seen: the version of the harness that sent it, and its stream line. */
export interface UnknownSeen {
  version?: string
  frame?: RecordRef
}

interface UnknownRecord extends UnknownSeen {
  harness: string
  kind: string
  reason: UnknownReason
  raw?: JsonValue
  count: number
}

const records = topic<UnknownRecord>("mako:native-unknown")

/** Report records no decoder reads; kept by whatever host follows them. */
export function retainUnknown(harness: string, kind: string, reason: UnknownReason, raw?: JsonValue, count = 1, seen: UnknownSeen = {}): void {
  records.publish({ harness, kind, reason, raw, count, ...seen })
}

/**
 * Live tool calls whose name the harness's vocabulary
 * (`packages/sessions/src/harnesses/`) doesn't declare, kept as kind
 * `tool <name>`: a tool the harness gained or renamed, shown by
 * `harness:doctor` instead of guessed at from the shared names.
 */
export function retainUndeclaredTools(harness: string, updates: readonly LiveUpdate[]): void {
  if (!records.heard || !hasVocabulary(harness)) return
  for (const update of updates) {
    if (update.kind !== "tool" || !update.name || isDeclaredTool(harness, update.name)) continue
    retainUnknown(harness, `tool ${update.name}`, "unknown", { name: update.name, title: update.title, toolKind: update.toolKind ?? null })
  }
}

/** What one host has seen and not decoded, and the file it keeps the first of each kind in. */
export class NativeUnknown {
  readonly path: string
  readonly #kinds = new Map<string, UnknownKind>()
  #queue: Promise<void> = Promise.resolve()

  /** `logs` is the directory the host log is in. */
  constructor(logs: string) {
    this.path = join(logs, NATIVE_UNKNOWN_FILE)
  }

  /** Keep what decoders report from now on; returns what stops it. */
  follow(): () => void {
    return records.subscribe((record) => this.#retain(record))
  }

  /** Most frequent first. */
  kinds(): UnknownKind[] {
    return [...this.#kinds.values()].sort((a, b) => b.count - a.count)
  }

  /** Resolves once every record kept so far is on disk. */
  flush(): Promise<void> {
    return this.#queue
  }

  #retain({ harness, version, frame, kind, reason, raw, count }: UnknownRecord): void {
    const key = `${harness}\0${version ?? ""}\0${kind}\0${reason}`
    const now = Date.now()
    const known = this.#kinds.get(key)
    if (known) {
      known.count += count
      known.newest = frame ? { at: now, frame } : { at: now }
      return
    }
    if (this.#kinds.size >= MAX_KINDS) this.#kinds.delete(this.#kinds.keys().next().value!)
    this.#kinds.set(key, { harness, ...version && { version }, kind, reason, count, firstSeen: now, newest: frame ? { at: now, frame } : { at: now } })
    hostLog("live", reason === "unknown" ? "native event not handled" : "native event unreadable", {
      harness, version, kind, kept: raw === undefined ? undefined : NATIVE_UNKNOWN_FILE,
    })
    if (raw === undefined) return
    const line = `${JSON.stringify({ at: new Date(now).toISOString(), harness, ...version && { version }, kind, reason, ...frame && { frame }, record: sample(raw) })}\n`
    const path = this.path
    this.#queue = this.#queue.then(() => append(path, line)).catch(() => undefined)
  }
}

function sample(raw: JsonValue): JsonValue | string {
  const text = nativeDiagnosticJson(raw)
  if (text.length > MAX_SAMPLE) return `${text.slice(0, MAX_SAMPLE)}… (${text.length} characters)`
  try {
    const parsed: JsonValue = JSON.parse(text)
    return parsed
  } catch {
    return text
  }
}

async function append(path: string, line: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const size = await stat(path).then((entry) => entry.size, () => 0)
  if (size > 0 && size + line.length > MAX_BYTES) await rename(path, `${path}.1`)
  await appendFile(path, line, "utf8")
}
