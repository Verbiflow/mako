import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { hasVocabulary, isDeclaredTool } from "@mako/sessions/tool-identity"
import type { JsonValue } from "./codex-app-json.js"
import type { LiveUpdate } from "@mako/sessions/live-content"
import type { UnreadRecord } from "@mako/sessions"
import { hostLog, hostLogPath } from "./host-log.js"
import { nativeDiagnosticJson } from "./native-diagnostic-json.js"

/**
 * Native records no decoder has a meaning for, kept so a new provider event
 * can be read and decided on instead of guessed at from its name.
 *
 * The first record of each harness and kind per host life is written whole
 * (up to `MAX_SAMPLE` characters) to `native-unknown.jsonl` beside the host
 * log; later ones are counted. The file rotates like the host log. It holds
 * conversation content, as the provider's own store does, so it stays on
 * this machine; bearer tokens and `token=` values are scrubbed.
 */
export const NATIVE_UNKNOWN_FILE = "native-unknown.jsonl"
const MAX_SAMPLE = 16 * 1024
const MAX_BYTES = 2 * 1024 * 1024
const MAX_KINDS = 1024

export type UnknownReason = "unknown" | "unreadable"

export interface UnknownKind {
  harness: string
  kind: string
  reason: UnknownReason
  count: number
  firstSeen: number
}

const kinds = new Map<string, UnknownKind>()
let queue: Promise<void> = Promise.resolve()

export function nativeUnknownPath(): string | null {
  const log = hostLogPath()
  return log ? join(dirname(log), NATIVE_UNKNOWN_FILE) : null
}

/** Count records and keep the first of their kind; never throws. */
export function retainUnknown(harness: string, kind: string, reason: UnknownReason, raw?: JsonValue, count = 1): void {
  const key = `${harness}\0${kind}\0${reason}`
  const known = kinds.get(key)
  if (known) {
    known.count += count
    return
  }
  if (kinds.size >= MAX_KINDS) kinds.delete(kinds.keys().next().value!)
  const now = Date.now()
  kinds.set(key, { harness, kind, reason, count, firstSeen: now })
  const path = nativeUnknownPath()
  hostLog("live", reason === "unknown" ? "native event not handled" : "native event unreadable", {
    harness, kind, kept: raw === undefined || !path ? undefined : NATIVE_UNKNOWN_FILE,
  })
  if (raw === undefined || !path) return
  const line = `${JSON.stringify({ at: new Date(now).toISOString(), harness, kind, reason, record: sample(raw) })}\n`
  queue = queue.then(() => append(path, line)).catch(() => undefined)
}

/**
 * Live tool calls whose name the harness's vocabulary
 * (`packages/sessions/src/harnesses/`) doesn't declare, kept as kind
 * `tool <name>`: a tool the harness gained or renamed, shown by
 * `harness:doctor` instead of guessed at from the shared names.
 */
export function retainUndeclaredTools(harness: string, updates: readonly LiveUpdate[]): void {
  if (!hasVocabulary(harness)) return
  for (const update of updates) {
    if (update.kind !== "tool" || !update.name || isDeclaredTool(harness, update.name)) continue
    retainUnknown(harness, `tool ${update.name}`, "unknown", { name: update.name, title: update.title, toolKind: update.toolKind ?? null })
  }
}

const retainedUnread = new Set<string>()
const MAX_RETAINED_UNREAD = 4096

/**
 * The saved records a thread's history couldn't read, kept as kind
 * `saved <kind>` beside the live ones, once per thread: its pages are read
 * again on every scroll and reopen. A declared kind history doesn't draw
 * yet is the harness table's own gap, not news.
 */
export function retainUnread(ref: { harness: string; path: string }, unread: readonly UnreadRecord[] | undefined): void {
  for (const record of unread ?? []) {
    if (record.reason === "undrawn") continue
    const key = `${ref.path}\0${record.kind}\0${record.reason}`
    if (retainedUnread.has(key)) continue
    if (retainedUnread.size >= MAX_RETAINED_UNREAD) retainedUnread.clear()
    retainedUnread.add(key)
    retainUnknown(ref.harness, `saved ${record.kind}`, record.reason, record.sample, record.count)
  }
}

/** What this host has seen and not decoded, most frequent first. */
export function unknownKinds(): UnknownKind[] {
  return [...kinds.values()].sort((a, b) => b.count - a.count)
}

/** Resolves once every record kept so far is on disk. */
export function flushUnknown(): Promise<void> {
  return queue
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
