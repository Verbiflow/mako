import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs"
import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { makoUserRoot } from "./mako-root.js"

/**
 * A detached process's durable record of what it did, one line each:
 * `ISO level scope message key=value…`.
 *
 * The host (`@mako/host/base/host-log`) and the shared sync reader
 * (`daemon-main.ts`) are both spawned with their stdio ignored, so this is
 * the only place either can say why it stopped. Both write through here, so
 * the format, the bound and the scrub are one.
 *
 * Bounded by rotation: when the file passes `maxBytes` it becomes `<path>.1`
 * and the previous `.1` is dropped. Writes are serialized and never throw; a
 * logging failure must not fail the process.
 *
 * Nothing secret belongs here. Callers pass explicit fields, never an
 * environment, a header list or a request body; messages and fields are
 * scrubbed of bearer tokens and `token=` style values before they are written.
 */
export type LogLevel = "info" | "warn" | "error"
export type LogFieldValue = string | number | boolean | null | undefined
export type LogFields = Record<string, LogFieldValue>

export interface ProcessLog {
  readonly path: string
  write(level: LogLevel, scope: string, message: string, fields?: LogFields): void
  /**
   * Writes the line now, synchronously, with every line still queued before
   * it: a process's last words, from an `exit` or `uncaughtException`
   * handler where nothing awaited would run.
   */
  writeNow(level: LogLevel, scope: string, message: string, fields?: LogFields): void
  /** Resolves once every line written so far is on disk. */
  flush(): Promise<void>
}

export const LOG_MAX_BYTES = 4 * 1024 * 1024
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

function fieldText(value: LogFieldValue): string {
  if (value === undefined || value === null) return "-"
  const text = scrubSecrets(String(value)).replace(/\s+/g, " ").trim()
  const bounded = text.length > FIELD_LIMIT ? `${text.slice(0, FIELD_LIMIT)}…` : text
  return /[\s"=]/.test(bounded) || bounded === "" ? JSON.stringify(bounded) : bounded
}

export function formatLogLine(
  at: Date,
  level: LogLevel,
  scope: string,
  message: string,
  fields?: LogFields
): string {
  const head = `${at.toISOString()} ${level.padEnd(5)} ${scope} ${scrubSecrets(message).replace(/\s+/g, " ").trim()}`
  const tail = Object.entries(fields ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${fieldText(value)}`)
  return `${[head, ...tail].join(" ")}\n`
}

export function openProcessLog(
  path: string,
  options: { maxBytes?: number; now?: () => Date } = {}
): ProcessLog {
  const maxBytes = options.maxBytes ?? LOG_MAX_BYTES
  const now = options.now ?? (() => new Date())
  /** Lines written but not yet appended, oldest first: `writeNow` takes them along. */
  const pending: string[] = []
  let queue: Promise<void> = Promise.resolve()

  const appendNext = async () => {
    const line = pending.shift()
    if (line === undefined) return
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
      pending.push(formatLogLine(now(), level, scope, message, fields))
      queue = queue.then(appendNext).catch(() => undefined)
    },
    writeNow(level, scope, message, fields) {
      pending.push(formatLogLine(now(), level, scope, message, fields))
      const text = pending.splice(0).join("")
      try {
        mkdirSync(dirname(path), { recursive: true })
        let size = 0
        try {
          size = statSync(path).size
        } catch {
          // No file yet.
        }
        if (size > 0 && size + text.length > maxBytes) renameSync(path, `${path}.1`)
        appendFileSync(path, text, "utf8")
      } catch {
        // Last words that can't be written are lost, never thrown.
      }
    },
    flush: () => queue,
  }
}

/**
 * The shared sync reader's log: one reader per user, serving every profile's
 * host, so it lives with the user's other shared state rather than in any
 * profile's data root. Its fatal-error reports go to `syncdReportsPath`.
 */
export function syncdLogPath(userRoot = makoUserRoot()): string {
  return join(userRoot, "logs", "syncd.log")
}

/** Where the reader's Node diagnostic reports go when V8 or Node aborts it (out of memory, a fatal error). */
export function syncdReportsPath(userRoot = makoUserRoot()): string {
  return join(userRoot, "logs", "syncd-reports")
}
