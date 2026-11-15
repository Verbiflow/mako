import { z } from "zod"
import { join } from "node:path"
import { format } from "node:util"
import {
  formatLogLine,
  LOG_MAX_BYTES,
  openProcessLog,
  type LogFields,
  type LogFieldValue,
  type LogLevel,
} from "@mako/sessions/process-log"
import { hostCorrelation } from "./host-client.js"
import { topic } from "./topic.js"

export { scrubSecrets } from "@mako/sessions/process-log"

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
 * The line format, the rotation to `<path>.1` and the secret scrub are
 * `@mako/sessions/process-log`'s, shared with the sync reader's own log
 * (`daemon-main.ts`), which can't import the host.
 *
 * Nothing secret belongs here. Callers pass explicit fields, never an
 * environment, a header list or a request body; provider stderr tails are
 * scrubbed of bearer tokens and `token=` query values before they are written.
 */
export type HostLogLevel = LogLevel
export type HostLogFieldValue = LogFieldValue
export type HostLogFields = LogFields

export interface HostLog {
  readonly path: string
  write(level: HostLogLevel, scope: string, message: string, fields?: HostLogFields): void
  /** Resolves once every line written so far is on disk. */
  flush(): Promise<void>
}

export const HOST_LOG_MAX_BYTES = LOG_MAX_BYTES

export const formatHostLogLine = formatLogLine

/** Bounded by rotation; writes are serialized and never throw: a logging failure must not fail the host. */
export function openHostLog(
  path: string,
  options: { maxBytes?: number; now?: () => Date } = {}
): HostLog {
  return openProcessLog(path, options)
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

const RejectionValueSchema = z.union([z.string(), z.number(), z.boolean(), z.bigint(), z.null(), z.undefined()])

/** Keep each nested failure separately: one formatted AggregateError loses the owners that failed. */
export function hostFailure(scope: string, message: string, error: Error): void {
  const queue: { value: unknown; path: string }[] = [{ value: error, path: "error" }]
  const seen = new Set<Error>()
  let truncated = false
  for (let count = 0; queue.length && count < 32; count++) {
    const { value, path } = queue.shift()!
    if (!(value instanceof Error)) {
      const primitive = RejectionValueSchema.safeParse(value)
      hostWarn(scope, message, { path, error: primitive.success ? String(primitive.data) : "Non-Error rejection" })
      continue
    }
    hostWarn(scope, message, { path, error: `${value.name}: ${value.message}`, stack: value.stack, repeated: seen.has(value) || undefined })
    if (seen.has(value)) continue
    seen.add(value)
    if ("cause" in value) queue.push({ value: value.cause, path: `${path}.cause` })
    if (value instanceof AggregateError) {
      truncated ||= value.errors.length > 32
      for (const [index, nested] of value.errors.slice(0, 32).entries())
        queue.push({ value: nested, path: `${path}.errors[${index}]` })
    }
  }
  if (queue.length || truncated) hostWarn(scope, message, { detailsTruncated: true, limit: 32 })
}

export function hostError(scope: string, message: string, fields?: HostLogFields): void {
  say("error", scope, message, fields)
}
