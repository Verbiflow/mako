import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname } from "node:path"
import { format } from "node:util"

/**
 * The host's durable record of what it did.
 *
 * The shared host is spawned detached with its stdio ignored, so `console`
 * output from the host process goes nowhere. Every provider start, startup
 * step, failure and exit is written here instead, one line each, so a thread
 * that reads "did not start" can be traced to the step that stalled and the
 * process that stalled it. Crash reports remain separate files; this log
 * mirrors their one-line summary so the timeline is in one place.
 *
 * Bounded by rotation: when the file passes `maxBytes` it becomes `<path>.1`
 * and the previous `.1` is dropped. Writes are serialized and never throw; a
 * logging failure must not fail the host.
 *
 * Nothing secret belongs here. Callers pass explicit fields, never an
 * environment, a header list or a request body; provider stderr tails are
 * scrubbed of bearer tokens and `token=` query values before they are written.
 */
export type HostLogLevel = "info" | "warn" | "error"
export type HostLogFieldValue = string | number | boolean | null | undefined
export type HostLogFields = Record<string, HostLogFieldValue>

export interface HostLog {
  readonly path: string
  write(level: HostLogLevel, scope: string, message: string, fields?: HostLogFields): void
  /** Resolves once every line written so far is on disk. */
  flush(): Promise<void>
}

export const HOST_LOG_MAX_BYTES = 4 * 1024 * 1024
const FIELD_LIMIT = 1_200

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g,
  /\b(token|key|secret|password|authorization)=([^\s&"']+)/gi,
]

/** Provider stderr can echo a launch header; keep the shape, drop the value. */
export function scrubSecrets(text: string): string {
  return text
    .replace(SECRET_PATTERNS[0]!, "Bearer …")
    .replace(SECRET_PATTERNS[1]!, (_match, name: string) => `${name}=…`)
}

function fieldText(value: HostLogFieldValue): string {
  if (value === undefined || value === null) return "-"
  const text = scrubSecrets(String(value)).replace(/\s+/g, " ").trim()
  const bounded = text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT)}…` : text
  return /[\s"=]/.test(bounded) || bounded === "" ? JSON.stringify(bounded) : bounded
}

export function formatHostLogLine(
  at: Date,
  level: HostLogLevel,
  scope: string,
  message: string,
  fields?: HostLogFields
): string {
  const head = `${at.toISOString()} ${level.padEnd(5)} ${scope} ${scrubSecrets(message).replace(/\s+/g, " ").trim()}`
  const tail = Object.entries(fields ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${fieldText(value)}`)
  return `${[head, ...tail].join(" ")}\n`
}

export function openHostLog(
  path: string,
  options: { maxBytes?: number; now?: () => Date } = {}
): HostLog {
  const maxBytes = options.maxBytes ?? HOST_LOG_MAX_BYTES
  const now = options.now ?? (() => new Date())
  let queue: Promise<void> = Promise.resolve()

  const append = async (line: string) => {
    await mkdir(dirname(path), { recursive: true })
    const size = await stat(path)
      .then((entry) => entry.size)
      .catch(() => 0)
    if (size > 0 && size + line.length > maxBytes) await rename(path, `${path}.1`)
    await appendFile(path, line, "utf8")
  }

  return {
    path,
    write(level, scope, message, fields) {
      const line = formatHostLogLine(now(), level, scope, message, fields)
      queue = queue.then(() => append(line)).catch(() => undefined)
    },
    flush: () => queue,
  }
}

let active: HostLog | null = null
let consoleMirrored = false

/**
 * Open the process-wide log and mirror `console.warn` / `console.error` into
 * it, so the existing one-line diagnostics scattered through the host are
 * kept as well. Installing twice replaces the sink and keeps one mirror.
 */
export function installHostLog(
  path: string,
  options: { maxBytes?: number; now?: () => Date } = {}
): HostLog {
  active = openHostLog(path, options)
  if (!consoleMirrored) {
    consoleMirrored = true
    const original = { warn: console.warn.bind(console), error: console.error.bind(console) }
    console.warn = (...args: unknown[]) => {
      original.warn(...args)
      active?.write("warn", "console", format(...args))
    }
    console.error = (...args: unknown[]) => {
      original.error(...args)
      active?.write("error", "console", format(...args))
    }
  }
  return active
}

export function hostLogPath(): string | null {
  return active?.path ?? null
}

export function hostLog(scope: string, message: string, fields?: HostLogFields): void {
  active?.write("info", scope, message, fields)
}

export function hostWarn(scope: string, message: string, fields?: HostLogFields): void {
  active?.write("warn", scope, message, fields)
}

export function hostError(scope: string, message: string, fields?: HostLogFields): void {
  active?.write("error", scope, message, fields)
}

export function flushHostLog(): Promise<void> {
  return active?.flush() ?? Promise.resolve()
}
