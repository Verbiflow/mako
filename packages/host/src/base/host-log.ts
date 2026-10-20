import { appendFile, mkdir, rename, stat } from "node:fs/promises"
import { dirname, join } from "node:path"
import { format } from "node:util"
import { hostCorrelation } from "./host-client.js"
import { topic } from "./topic.js"

/**
 * The host's durable record of what it did.
 *
 * The shared host is spawned detached; its raw stdout and stderr go to
 * `host-output.log` beside this file, unstructured. Every provider start,
 * startup step, failure and exit is written here, one line each, so a thread
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

/** Where a process with this data root keeps its log and what is kept beside it. */
export function logsRoot(dataRoot: string): string {
  return join(dataRoot, "logs")
}

export interface HostLogLine {
  level: HostLogLevel
  scope: string
  message: string
  fields?: HostLogFields
}

/**
 * Every line any module logs. Modules publish without knowing where lines
 * go; the process keeps them (`keepHostLog`), and nothing is formatted
 * while nobody does.
 */
const lines = topic<HostLogLine>("mako:host-log")

/** Keep every line published from now on in `log`; returns what stops keeping them. */
export function keepHostLog(log: HostLog): () => void {
  return lines.subscribe((line) => log.write(line.level, line.scope, line.message, line.fields))
}

/** Hears every line published from now on, as published; returns what stops hearing them. */
export function followHostLog(listener: (line: HostLogLine) => void): () => void {
  return lines.subscribe(listener)
}

/** Whether anything keeps the log, so a report that would be lost goes to stderr instead. */
export function hostLogKept(): boolean {
  return lines.heard
}

/**
 * Publish `console.warn` and `console.error` as log lines as well, so the
 * one-line diagnostics scattered through the code are kept with the rest.
 * The console belongs to the process, which mirrors it once; returns what
 * puts the console back.
 */
export function mirrorConsole(): () => void {
  const { warn, error } = console
  console.warn = (...args: unknown[]) => {
    warn.apply(console, args)
    say("warn", "console", format(...args))
  }
  console.error = (...args: unknown[]) => {
    error.apply(console, args)
    say("error", "console", format(...args))
  }
  return () => {
    console.warn = warn
    console.error = error
  }
}

/** A process's log: opened at `path`, kept, and fed by the console. A process installs one. */
export function installHostLog(
  path: string,
  options: { maxBytes?: number; now?: () => Date } = {}
): HostLog {
  const log = openHostLog(path, options)
  keepHostLog(log)
  mirrorConsole()
  return log
}

/** A line written while a call runs names that call, so one request's lines are found together. */
function say(level: HostLogLevel, scope: string, message: string, fields?: HostLogFields): void {
  if (!lines.heard) return
  const correlationId = hostCorrelation()
  lines.publish({
    level,
    scope,
    message,
    fields: correlationId && fields?.correlationId === undefined ? { ...fields, correlationId } : fields,
  })
}

export function hostLog(scope: string, message: string, fields?: HostLogFields): void {
  say("info", scope, message, fields)
}

export function hostWarn(scope: string, message: string, fields?: HostLogFields): void {
  say("warn", scope, message, fields)
}

export function hostError(scope: string, message: string, fields?: HostLogFields): void {
  say("error", scope, message, fields)
}
