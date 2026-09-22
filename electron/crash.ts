import { app, crashReporter } from "electron"
import { randomUUID } from "node:crypto"
import { hostError, hostLogPath } from "./host-log.js"
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Crash reporting, on this machine only.
 *
 * Nothing here leaves the computer. That is a deliberate limit rather than an
 * unfinished one: an agent's window is full of the user's source, their prompts
 * and their tool output, so a crash report is not something to post anywhere by
 * default. What this gives instead is the thing that was actually missing — a
 * failure that leaves a trace you can find, read, and hand over on purpose.
 *
 * The seam for a remote sink is `write`: point it at a transport and every
 * report goes there too. Nothing else needs to change.
 */

export type CrashKind =
  | "main-uncaught"
  | "main-rejection"
  | "renderer-error"
  | "renderer-rejection"
  | "renderer-gone"
  | "child-gone"

interface CrashApp {
  version: string
  electron: string
  chrome: string
  node: string
}

interface CrashOs {
  platform: string
  arch: string
  release: string
}

export interface CrashReport {
  id: string
  kind: CrashKind
  at: string
  message: string
  stack?: string
  /** Where it came from, when the renderer can say. */
  source?: string
  app: CrashApp
  os: CrashOs
  /** What the app was doing just before. */
  breadcrumbs: string[]
}

interface JsonObject {
  [key: string]: JsonValue
}

type JsonValue = null | boolean | number | string | JsonObject | JsonValue[]

interface CaughtProperties {
  message?: JsonValue
  stack?: JsonValue
}

interface CrashDescription {
  message: string
  stack?: string
}

/** Reports kept on disk. Old ones are pruned so this cannot grow without end. */
const KEEP = 40

/**
 * A short trail of what happened before the crash.
 *
 * Deliberately small and deliberately not the payloads — channel names and
 * event types, never their arguments. A breadcrumb trail that carried the
 * arguments would be a log of the user's prompts and their source, which is
 * exactly what this file promises not to keep.
 */
const TRAIL = 40
const trail: string[] = []
let reportDirectory: string | undefined
let reportSource: string | undefined
let installed = false

export function breadcrumb(note: string) {
  trail.push(`${new Date().toISOString()} ${note}`)
  if (trail.length > TRAIL) trail.shift()
}

export function crashesDir() {
  return reportDirectory ?? join(app.getPath("userData"), "crashes")
}

function normalizeCause(cause: unknown): CrashDescription {
  if (cause instanceof Error)
    return { message: cause.message || cause.name, stack: cause.stack }

  if (Object(cause) === cause && !(cause instanceof Function)) {
    const value: CaughtProperties = Object(cause)
    if (isString(value.message)) {
      return {
        message: value.message,
        stack: isString(value.stack) ? value.stack : undefined,
      }
    }
    try {
      return { message: JSON.stringify(cause).slice(0, 2000) }
    } catch {
      return { message: String(cause) }
    }
  }
  return { message: String(cause) }
}

/** Sortable across processes, without collisions between host and client. */
function nextId() {
  // Hosts and desktop clients write into the same report directory.
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`
}

export function record(kind: CrashKind, cause: unknown, source?: string): CrashReport {
  const { message, stack } = normalizeCause(cause)
  const report: CrashReport = {
    id: nextId(),
    kind,
    at: new Date().toISOString(),
    message,
    stack,
    source: [reportSource, source].filter(Boolean).join(" · ") || undefined,
    app: {
      version: app.getVersion(),
      electron: process.versions.electron ?? "",
      chrome: process.versions.chrome ?? "",
      node: process.versions.node ?? "",
    },
    os: { platform: process.platform, arch: process.arch, release: process.getSystemVersion?.() ?? "" },
    breadcrumbs: [...trail],
  }
  write(report)
  return report
}

function write(report: CrashReport) {
  try {
    const dir = crashesDir()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${report.id}.json`), JSON.stringify(report, null, 2), "utf8")
    prune(dir)
  } catch {
    // A crash reporter that throws while reporting a crash is worse than one
    // that quietly gives up; the console line below is the fallback.
  }
  hostError("crash", report.message, { kind: report.kind, id: report.id, source: report.source })
  if (!hostLogPath()) console.error(`[crash:${report.kind}] ${report.message}\n${report.stack ?? ""}`)
}

function prune(dir: string) {
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
  for (const name of files.slice(0, Math.max(0, files.length - KEEP))) {
    try {
      rmSync(join(dir, name))
    } catch {
      // Nothing to do about a report we cannot delete.
    }
  }
}

function parseCrashReport(raw: string): CrashReport | null {
  const value: JsonValue = JSON.parse(raw)
  const root = objectValue(value)
  if (!root) return null

  const id = stringValue(root.id)
  const kind = crashKindValue(root.kind)
  const at = stringValue(root.at)
  const message = stringValue(root.message)
  const stack = optionalStringValue(root.stack)
  const source = optionalStringValue(root.source)
  const reportApp = crashAppValue(root.app)
  const reportOs = crashOsValue(root.os)
  const breadcrumbs = breadcrumbValues(root.breadcrumbs)

  if (
    id === undefined ||
    kind === null ||
    at === undefined ||
    message === undefined ||
    stack === null ||
    source === null ||
    !reportApp ||
    !reportOs ||
    !breadcrumbs
  )
    return null

  const report: CrashReport = {
    id,
    kind,
    at,
    message,
    app: reportApp,
    os: reportOs,
    breadcrumbs,
  }
  if (stack !== undefined) report.stack = stack
  if (source !== undefined) report.source = source
  return report
}

function crashAppValue(value: JsonValue | undefined): CrashApp | null {
  const root = objectValue(value)
  const version = stringValue(root?.version)
  const electron = stringValue(root?.electron)
  const chrome = stringValue(root?.chrome)
  const node = stringValue(root?.node)
  if (
    !root ||
    version === undefined ||
    electron === undefined ||
    chrome === undefined ||
    node === undefined
  )
    return null
  return { version, electron, chrome, node }
}

function crashOsValue(value: JsonValue | undefined): CrashOs | null {
  const root = objectValue(value)
  const platform = stringValue(root?.platform)
  const arch = stringValue(root?.arch)
  const release = stringValue(root?.release)
  if (
    !root ||
    platform === undefined ||
    arch === undefined ||
    release === undefined
  )
    return null
  return { platform, arch, release }
}

function breadcrumbValues(value: JsonValue | undefined): string[] | null {
  if (!Array.isArray(value)) return null
  const breadcrumbs: string[] = []
  for (const entry of value) {
    if (!isString(entry)) return null
    breadcrumbs.push(entry)
  }
  return breadcrumbs
}

function crashKindValue(value: JsonValue | undefined): CrashKind | null {
  if (!isString(value)) return null
  switch (value) {
    case "main-uncaught":
    case "main-rejection":
    case "renderer-error":
    case "renderer-rejection":
    case "renderer-gone":
    case "child-gone":
      return value
    default:
      return null
  }
}

function objectValue(value: JsonValue | undefined): JsonObject | null {
  return isJsonObject(value) ? value : null
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return isString(value) ? value : undefined
}

function optionalStringValue(
  value: JsonValue | undefined
): string | null | undefined {
  if (value === undefined) return undefined
  return isString(value) ? value : null
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return (
    value !== undefined &&
    value !== null &&
    !Array.isArray(value) &&
    Object.prototype.toString.call(value) === "[object Object]"
  )
}

function isString(value: JsonValue | undefined): value is string {
  return Object.prototype.toString.call(value) === "[object String]"
}

export function listCrashes(): CrashReport[] {
  try {
    const dir = crashesDir()
    mkdirSync(dir, { recursive: true })
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .reverse()
      .map((name) => {
        try {
          return parseCrashReport(readFileSync(join(dir, name), "utf8"))
        } catch {
          return null
        }
      })
      .filter((report): report is CrashReport => report !== null)
  } catch {
    return []
  }
}

export function clearCrashes() {
  try {
    rmSync(crashesDir(), { recursive: true, force: true })
  } catch {
    // Same as above: this is best effort by design.
  }
}

/**
 * Arm the main process.
 *
 * `uncaughtException` is handled rather than left to kill the process: in a
 * desktop app the alternative is the window vanishing with no explanation,
 * which is the exact failure this file exists to end. A caught exception is
 * recorded and the app carries on — degraded, but present and able to say so.
 */
export function installCrashReporting(options: { directory?: string; source?: string } = {}) {
  if (installed) return
  installed = true
  reportDirectory = options.directory
  reportSource = options.source
  // Native failures cannot run a JavaScript exception handler. Keep their dumps
  // on this machine, including when the desktop was launched with no terminal.
  try {
    const dumps = join(app.getPath("userData"), "Crashpad")
    mkdirSync(dumps, { recursive: true })
    app.setPath("crashDumps", dumps)
    crashReporter.start({ uploadToServer: false })
  } catch (error) {
    record("main-uncaught", error, "native crash reporter startup")
  }
  process.on("uncaughtException", (error) => {
    record("main-uncaught", error)
  })
  process.on("unhandledRejection", (reason) => {
    record("main-rejection", reason)
  })
  app.on("child-process-gone", (_event, details) => {
    if (details.reason === "clean-exit") return
    record("child-gone", new Error(`${details.type} exited: ${details.reason} (exit ${details.exitCode})`))
  })
}
