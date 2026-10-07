import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import type { JsonObject, JsonValue } from "./codex-app-json.js"
import { hostLog, hostLogPath } from "./host-log.js"
import { nativeDiagnosticJson } from "./native-diagnostic-json.js"

/**
 * Opt-in recording of a harness's native messages with secrets scrubbed,
 * so a session that rendered wrong can be decoded again
 * (`npm run decode -- codex <capture>`) and kept as a fixture.
 *
 * Off unless `MAKO_NATIVE_CAPTURE` names the harness (`codex`,
 * `codex,claude` or `all`). One file per conversation goes to
 * `native-captures/` beside the host log: a header line with what the driver
 * knew when the first message arrived, then `{ "at", "message" }` lines,
 * `{ "at", "prompted": true, "text" }` where a turn opened that the wire
 * does not mark itself, so a replay knows where each turn began and what
 * Mako drew for it, and `{ "at", "steered": true, "text" }` where the harness
 * took a message Mako steered into the running turn. It holds
 * conversation content and stays on this machine; bearer tokens and `token=`
 * values are scrubbed. A capture stops at `MAX_BYTES`.
 */
export const NATIVE_CAPTURE_ENV = "MAKO_NATIVE_CAPTURE"
export const NATIVE_CAPTURE_DIR = "native-captures"
const MAX_BYTES = 64 * 1024 * 1024

export interface NativeCapture {
  readonly path: string
  record(message: JsonValue): void
  /**
   * A turn opened: the turn the messages after it belong to. `text` is what
   * Mako drew for the prompt it sent; a turn the harness opened itself has none.
   */
  prompted(text?: string): void
  /** The harness took `text`, which Mako steered into the running turn. */
  steered(text: string): void
  /** Resolves once every recorded line is on disk. */
  flush(): Promise<void>
}

export function capturesHarness(harness: string, setting = process.env[NATIVE_CAPTURE_ENV]): boolean {
  const names = (setting ?? "").split(",").map((name) => name.trim().toLowerCase())
  return names.includes("all") || names.includes(harness)
}

/**
 * A capture for one conversation, or null when capture is off for the
 * harness. `session` is read once, when the first message arrives.
 */
export function nativeCapture(
  harness: string,
  conversation: string,
  session: () => JsonObject,
  root = defaultRoot()
): NativeCapture | null {
  if (!root || !capturesHarness(harness)) return null
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const path = join(root, `${harness}-${conversation.replace(/[^\w.-]+/g, "_")}-${stamp}.jsonl`)
  let queue: Promise<void> = Promise.resolve()
  let bytes = 0
  let stopped = false
  const write = (line: string) => {
    queue = queue.then(() => appendFile(path, line, "utf8")).catch((error) => {
      stopped = true
      hostLog("live", "native capture stopped", { harness, path, error: String(error) })
    })
  }
  const append = (line: string): boolean => {
    const size = Buffer.byteLength(line, "utf8")
    if (bytes + size > MAX_BYTES) {
      stopped = true
      write(`${JSON.stringify({ truncated: true, bytes })}\n`)
      return false
    }
    bytes += size
    write(line)
    return true
  }
  const line = (body: JsonObject) => {
    if (stopped) return
    if (bytes === 0) {
      queue = queue.then(() => mkdir(dirname(path), { recursive: true })).then(() => undefined)
      const header = { capture: 1, harness, conversation, session: session() }
      if (!append(`${nativeDiagnosticJson(header)}\n`)) return
      hostLog("live", "native capture started", { harness, path })
    }
    append(`${nativeDiagnosticJson({ at: new Date().toISOString(), ...body })}\n`)
  }
  return {
    path,
    record: (message) => line({ message }),
    prompted: (text) => line(text === undefined ? { prompted: true } : { prompted: true, text }),
    steered: (text) => line({ steered: true, text }),
    flush: () => queue,
  }
}

function defaultRoot(): string | null {
  const log = hostLogPath()
  return log ? join(dirname(log), NATIVE_CAPTURE_DIR) : null
}
