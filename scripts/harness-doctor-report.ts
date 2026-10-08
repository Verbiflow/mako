import { createReadStream } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline"
import { z } from "zod"
import { identifyTool } from "@mako/sessions/tool-identity"
import { HARNESS_TOOL_SAMPLES } from "../src/dev/harness-tool-samples.ts"
import type { JsonValue } from "../electron/codex-app-json.ts"
import { compareVersions, parseVersion } from "../electron/contracts/runtime-version.ts"
import { scrubSecrets } from "../electron/host-log.ts"
import { NATIVE_CAPTURE_DIR } from "../electron/native-capture.ts"
import { NATIVE_UNKNOWN_FILE } from "../electron/native-unknown.ts"
import type { HarnessFamily } from "../electron/providers/harness-definition.ts"
import { providerHost } from "../electron/providers/index.ts"
import { capabilityText, LIVE_CAPABILITY_KEYS, LIVE_CAPABILITY_LABELS, type LiveCapabilities } from "../electron/contracts/harness-capabilities.ts"
import { readRuntimeVersion } from "../electron/runtime-updates.ts"
import { FIXTURE_ROOT, loadFixtures, type FixtureFile } from "./native-decoding.ts"

/**
 * What `npm run harness:doctor` reports for each harness, from local files
 * only: its definition, the runtime installed against the fixtures' versions,
 * decoder coverage, tool names nothing resolves, and what the host logged
 * about native events it could not decode.
 */

const REPO_ROOT = join(import.meta.dirname, "..")
const DAY_MS = 24 * 60 * 60 * 1000
const HOST_KINDS_SHOWN = 6

/** Every family a `HarnessDefinition` names; a new one fails the type check here. */
const FAMILY_LIST = {
  live: true, profile: true, decoder: true, acp: true, accounts: true, connection: true, updates: true,
  nativeRunner: true, processProbe: true, mcp: true, skills: true, sessionEmitter: true, usageHistory: true,
  hooks: true, commands: true, toolEditing: true, skillEditing: true, mcpEditing: true, artifactPreview: true,
} satisfies Record<HarnessFamily, true>
// SAFETY: `satisfies` holds the literal's keys to exactly the families.
const FAMILIES = Object.keys(FAMILY_LIST) as HarnessFamily[]

/**
 * The SDK each harness's sessions go through. Cursor's sessions run inside
 * its SDK, so the SDK's version is the runtime's; `cursor-agent` is only the
 * CLI Settings updates.
 */
export interface Sdk {
  name: string
  version: string
}

export interface FamilyStatus {
  family: HarnessFamily
  status: "capability" | "lacks" | "notBuilt"
  reason?: string
}


export interface InstalledRuntime {
  /** The version fixtures are compared with; null when none could be read. */
  version: string | null
  /** Where the version was read. */
  from: string | null
  sdk: Sdk | null
  problem?: string
}

export type InstalledReader = (harness: string) => Promise<InstalledRuntime>

export type VersionVerdict = "unreadable" | "no-fixture-version" | "newer-than-fixtures" | "covered"

export interface VersionReport {
  installed: InstalledRuntime
  newestFixture: string | null
  newestCaptured: string | null
  verdict: VersionVerdict
  /** The installed SDK against the newest fixture that names the same SDK. */
  sdk: { installed: Sdk; newestFixture: string | null; newer: boolean } | null
}

export interface DecoderReport {
  absent?: string
  fixtures: number
  captured: number
  written: number
  invalid: string[]
  decodedKinds: number
  unexercised: string[]
  silentKinds: number
  silentExercised: number
}

export interface ToolReport {
  samples: number
  /** Sample names that resolve to `other`; `expected` when the sample says so. */
  other: { name: string; expected: boolean }[]
}

export interface UnknownGroup {
  kind: string
  reason: string
  count: number
  newest: string
  /** The fixture whose step of this kind decodes now: a build since the log was written handles it. */
  handledBy?: string
}

export interface AuthLine {
  at: string
  message: string
  fields: Record<string, string>
}

export interface HostLogKind {
  kind: string
  reason: "unknown" | "unreadable"
  count: number
  /** As on `UnknownGroup`. */
  handledBy?: string
}

export interface HostLogCounts {
  notHandled: number
  unreadable: number
  /** The kinds those lines name, most frequent first. */
  kinds: HostLogKind[]
}

/** The sign-in lines a harness's declared host-log scope recorded. */
export interface SignInLines {
  scope: string
  count: number
  latest: AuthLine | null
}

export interface LogReport {
  /** null: the file is missing, so nothing was recorded. */
  unknown: UnknownGroup[] | null
  hostLog: HostLogCounts | null
  captures: number
  /** Only for a harness that declares a sign-in log scope. */
  signIn?: SignInLines
}

export interface HarnessReport {
  harness: string
  families: FamilyStatus[]
  /** Every live capability as the window shows it; null without a live driver. */
  live: LiveCapabilities | null
  version: VersionReport
  decoder: DecoderReport
  tools: ToolReport
  logs: LogReport
}

export interface DoctorReport {
  dataDir: string
  logs: string
  days: number
  since: string
  harnesses: HarnessReport[]
}

export interface DoctorOptions {
  dataDir: string
  days: number
  now?: Date
  harness?: string
  installed?: InstalledReader
  fixtureRoot?: string
}

/**
 * Where the app keeps `logs/host.log`: Electron's userData for the `mako`
 * app, `MAKO_DATA_ROOT` when a launcher set it, and `-<MAKO_PROFILE>` beside
 * it for a named profile (a source checkout's desk is `MAKO_PROFILE=dev`).
 */
export function defaultDataDir(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string {
  if (env.MAKO_DATA_ROOT) return env.MAKO_DATA_ROOT
  const home = env.HOME || homedir()
  const appData = platform === "darwin"
    ? join(home, "Library", "Application Support")
    : platform === "win32" ? env.APPDATA || join(home, "AppData", "Roaming") : env.XDG_CONFIG_HOME || join(home, ".config")
  return join(appData, env.MAKO_PROFILE ? `mako-${env.MAKO_PROFILE}` : "mako")
}

export function harnessIds(): string[] {
  return providerHost.harnesses.list().map(({ provider }) => provider)
}

export async function doctorReport(options: DoctorOptions): Promise<DoctorReport> {
  const now = options.now ?? new Date()
  const since = new Date(now.getTime() - options.days * DAY_MS)
  const logs = join(options.dataDir, "logs")
  const harnesses = options.harness ? [options.harness] : harnessIds()
  const [logReports, fixtures] = await Promise.all([
    readLogs(logs, since, harnesses),
    loadFixtures(undefined, options.fixtureRoot ?? FIXTURE_ROOT),
  ])
  const installed = options.installed ?? readInstalled
  const reports = await Promise.all(harnesses.map(async (harness): Promise<HarnessReport> => {
    const files = fixtures.files.filter((file) => file.fixture.harness === harness)
    return {
      harness,
      families: familyStatus(harness),
      live: providerHost.harnesses.get(harness)?.capabilities ?? null,
      version: versionReport(await installed(harness), files),
      decoder: decoderReport(harness, files, fixtures.invalid.filter((file) => file.name.startsWith(`${harness}/`)).map((file) => file.name)),
      tools: toolReport(harness),
      logs: markHandled(logReports.get(harness) ?? emptyLogs(harness), handledKinds(harness, files)),
    }
  }))
  return { dataDir: options.dataDir, logs, days: options.days, since: since.toISOString(), harnesses: reports }
}

export function familyStatus(harness: string): FamilyStatus[] {
  const record = providerHost.harnesses.get(harness)
  return FAMILIES.map((family) => {
    const absent = record?.absent[family]
    if (!absent) return { family, status: "capability" }
    return { family, status: absent.absent === "harness" ? "lacks" : "notBuilt", reason: absent.reason }
  })
}

/** The runtime sessions launch, read the way Settings reads it: `--version`, or the SDK's package. */
export async function readInstalled(harness: string): Promise<InstalledRuntime> {
  const { sdk: sdkName, runsInSdk } = providerHost.harnesses.get(harness)?.diagnostics ?? {}
  const sdk = sdkName ? await readSdk(sdkName) : null
  if (runsInSdk)
    return sdk
      ? { version: sdk.version, from: `node_modules/${sdk.name}`, sdk }
      : { version: null, from: null, sdk, problem: `${sdkName} is not installed` }
  const updates = providerHost.updateSources.get(harness)
  if (!updates) return { version: null, from: null, sdk, problem: "declares no runtime it updates" }
  try {
    const binary = await updates.binary(process.env)
    if (!binary) return { version: null, from: null, sdk, problem: "not installed" }
    const version = parseVersion(await readRuntimeVersion(binary, updates.versionArgs ?? ["--version"], process.env)) ?? null
    return version ? { version, from: binary, sdk } : { version, from: binary, sdk, problem: "printed no version" }
  } catch (error) {
    return { version: null, from: null, sdk, problem: error instanceof Error ? error.message : String(error) }
  }
}

const PackageVersionSchema = z.object({ version: z.string() })

async function readSdk(name: string): Promise<Sdk | null> {
  const text = await readFile(join(REPO_ROOT, "node_modules", name, "package.json"), "utf8").catch(() => null)
  const parsed = text === null ? null : PackageVersionSchema.safeParse(JSON.parse(text))
  return parsed?.success ? { name, version: parsed.data.version } : null
}

export function versionReport(installed: InstalledRuntime, files: FixtureFile[]): VersionReport {
  const newest = (versions: (string | null | undefined)[]) =>
    versions.filter((version) => version != null).sort(compareVersions).at(-1) ?? null
  const newestFixture = newest(files.map((file) => file.fixture.native.version))
  const newestCaptured = newest(files.filter((file) => file.fixture.native.origin === "captured").map((file) => file.fixture.native.version))
  const verdict: VersionVerdict = !installed.version ? "unreadable"
    : !newestFixture ? "no-fixture-version"
      : compareVersions(installed.version, newestFixture) > 0 ? "newer-than-fixtures" : "covered"
  const sdk = installed.sdk
  const newestSdk = sdk ? newest(files.map((file) => file.fixture.native.sdk?.name === sdk.name ? file.fixture.native.sdk.version : null)) : null
  return {
    installed,
    newestFixture,
    newestCaptured,
    verdict,
    sdk: sdk ? { installed: sdk, newestFixture: newestSdk, newer: Boolean(newestSdk && compareVersions(sdk.version, newestSdk) > 0) } : null,
  }
}

export function decoderReport(harness: string, files: FixtureFile[], invalid: string[]): DecoderReport {
  const source = providerHost.decoders.get(harness)
  const captured = files.filter((file) => file.fixture.native.origin === "captured").length
  const counts = { fixtures: files.length, captured, written: files.length - captured, invalid }
  if (!source) {
    const absent = providerHost.harnesses.get(harness)?.absent.decoder
    return { ...counts, absent: absent?.reason ?? "no decoder", decodedKinds: 0, unexercised: [], silentKinds: 0, silentExercised: 0 }
  }
  const exercised = new Set(files.flatMap((file) => file.fixture.steps.map((step) => source.kind(step.message))))
  return {
    ...counts,
    decodedKinds: source.decoded.size,
    unexercised: [...source.decoded].filter((kind) => !exercised.has(kind)).sort(),
    silentKinds: source.silent.size,
    silentExercised: [...source.silent].filter((kind) => exercised.has(kind)).length,
  }
}

/**
 * Each kind a fixture step decodes without an unknown, and the first fixture
 * that shows it. Logs keep a week of kinds an older build did not handle;
 * this tells those apart from the ones still open.
 */
function handledKinds(harness: string, files: FixtureFile[]): Map<string, string> {
  const source = providerHost.decoders.get(harness)
  const handled = new Map<string, string>()
  if (!source) return handled
  for (const file of files)
    for (const step of file.fixture.steps) {
      const kind = source.kind(step.message)
      if (!step.decoded || handled.has(kind) || step.decoded.some(isUnknownDecoding)) continue
      handled.set(kind, file.name)
    }
  return handled
}

const UnknownDecoding = z.object({ kind: z.literal("unknown") })

function isUnknownDecoding(item: JsonValue): boolean {
  return UnknownDecoding.safeParse(item).success
}

/** An unreadable record is a known kind that arrived malformed; a fixture of the kind does not show it reads now. */
function markHandled(logs: LogReport, handled: Map<string, string>): LogReport {
  for (const entry of [...logs.unknown ?? [], ...logs.hostLog?.kinds ?? []]) {
    const fixture = entry.reason === "unknown" ? handled.get(entry.kind) : undefined
    if (fixture) entry.handledBy = fixture
  }
  return logs
}

export function toolReport(harness: string): ToolReport {
  const samples = HARNESS_TOOL_SAMPLES.filter((sample) => sample.source.harness === harness)
  const other = samples
    .filter((sample) => identifyTool(sample.source).kind === "other")
    .map((sample) => ({ name: sample.source.name ?? sample.source.title ?? "(unnamed)", expected: sample.expect.kind === "other" }))
  return { samples: samples.length, other }
}

function emptyLogs(harness: string): LogReport {
  const report: LogReport = { unknown: null, hostLog: null, captures: 0 }
  const scope = providerHost.harnesses.get(harness)?.diagnostics.signInLog
  if (scope) report.signIn = { scope, count: 0, latest: null }
  return report
}

const UnknownLineSchema = z.object({ at: z.string(), harness: z.string(), kind: z.string(), reason: z.string() })
const HOST_LINE = /^(\S+) +(?:info|warn|error) +(\S+) (.*)$/
const FIELD = /(?:^| )([A-Za-z_][\w.-]*)=("(?:[^"\\]|\\.)*"|\S*)/g
const OPAQUE_RUN = /^[A-Za-z0-9._~+/=-]{24,}$/
const LONG_HEX = /^[0-9a-f]{32,}$/i
const SECRET_KEY = /token|secret|password|passwd|authorization|cookie|credential|api_?key/i
const STATE_WORD = /^[a-z][a-z-]{0,15}$/

/**
 * One pass over each log for every harness asked about. Lines older than
 * `since` are skipped by their leading timestamp, before any parse; a
 * rotated `.1` file last written before `since` is not opened.
 */
export async function readLogs(logs: string, since: Date, harnesses: string[]): Promise<Map<string, LogReport>> {
  const reports = new Map(harnesses.map((harness) => [harness, emptyLogs(harness)]))
  const cutoff = since.toISOString()
  const unknownGroups = new Map<string, Map<string, UnknownGroup>>()

  const unknownFound = await eachRecentLine(join(logs, NATIVE_UNKNOWN_FILE), since, (line) => {
    if (line.startsWith('{"at":"') && line.slice(7, 31) < cutoff) return
    const parsed = UnknownLineSchema.safeParse(parseJson(line))
    if (!parsed.success || parsed.data.at < cutoff || !reports.has(parsed.data.harness)) return
    const { harness, kind, reason, at } = parsed.data
    const groups = unknownGroups.get(harness) ?? new Map<string, UnknownGroup>()
    unknownGroups.set(harness, groups)
    const key = `${kind}\0${reason}`
    const group = groups.get(key) ?? { kind, reason, count: 0, newest: at }
    group.count++
    if (at > group.newest) group.newest = at
    groups.set(key, group)
  })

  const counts = new Map(harnesses.map((harness): [string, HostLogCounts] => [harness, { notHandled: 0, unreadable: 0, kinds: [] }]))
  const hostKinds = new Map<string, HostLogKind>()
  const signIns = new Map([...reports.values()].flatMap((report) => report.signIn ? [[report.signIn.scope, report.signIn]] : []))
  const signInMarks = [...signIns.keys()].map((scope) => ` ${scope} `)
  const hostFound = await eachRecentLine(join(logs, "host.log"), since, (line) => {
    if (line.slice(0, 24) < cutoff) return
    const native = line.includes(" native event ")
    if (!native && !signInMarks.some((mark) => line.includes(mark))) return
    const match = HOST_LINE.exec(line)
    if (!match) return
    const [, at = "", scope = "", rest = ""] = match
    const fields = hostFields(rest)
    const message = rest.slice(0, fields.start).trim()
    const signIn = signIns.get(scope)
    if (signIn) {
      signIn.count++
      if (!signIn.latest || at >= signIn.latest.at) signIn.latest = { at, message: scrubSecrets(message), fields: fields.values }
      return
    }
    const harness = fields.values.harness ?? ""
    const seen = counts.get(harness)
    const reason = message === "native event not handled" ? "unknown" : message === "native event unreadable" ? "unreadable" : null
    if (!seen || !reason) return
    if (reason === "unknown") seen.notHandled++
    else seen.unreadable++
    const kind = fields.values.kind ?? "(no kind)"
    const key = `${harness}\0${kind}\0${reason}`
    const known = hostKinds.get(key)
    if (known) known.count++
    else {
      const entry: HostLogKind = { kind, reason, count: 1 }
      hostKinds.set(key, entry)
      seen.kinds.push(entry)
    }
  })
  for (const seen of counts.values()) seen.kinds.sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))

  const captures = await readdir(join(logs, NATIVE_CAPTURE_DIR)).catch(() => [])
  for (const [harness, report] of reports) {
    if (unknownFound) report.unknown = [...(unknownGroups.get(harness)?.values() ?? [])].sort((a, b) => b.count - a.count || b.newest.localeCompare(a.newest))
    if (hostFound) report.hostLog = counts.get(harness) ?? null
    report.captures = captures.filter((name) => name.startsWith(`${harness}-`) && name.endsWith(".jsonl")).length
  }
  return reports
}

/** Reads `<path>.1` then `<path>`, streamed; false when neither exists. */
async function eachRecentLine(path: string, since: Date, visit: (line: string) => void): Promise<boolean> {
  let found = false
  for (const file of [`${path}.1`, path]) {
    const entry = await stat(file).catch(() => null)
    if (!entry) continue
    found = true
    if (entry.mtime < since) continue
    const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity })
    for await (const line of lines) visit(line)
  }
  return found
}

function parseJson(line: string): JsonValue | null {
  try {
    return z.json().parse(JSON.parse(line))
  } catch {
    return null
  }
}

interface HostFields {
  /** Where the `key=value` fields begin in the line's message. */
  start: number
  values: Record<string, string>
}

/** A host-log line's fields, each scrubbed again so nothing token-like is printed. */
function hostFields(rest: string): HostFields {
  const values: Record<string, string> = {}
  let start = rest.length
  for (const match of rest.matchAll(FIELD)) {
    const [whole, key = "", raw = ""] = match
    start = Math.min(start, match.index + (whole.startsWith(" ") ? 1 : 0))
    const quoted = raw.startsWith('"') ? z.string().safeParse(parseJson(raw)) : null
    values[key] = printable(key, quoted?.success ? quoted.data : raw)
  }
  return { start, values }
}

/**
 * Claude's auth lines name credential fields by their state (`present`,
 * `expired`); any other value under a secret's name, or anything opaque
 * enough to be one, is withheld.
 */
function printable(key: string, raw: string): string {
  const value = scrubSecrets(`${key}=${raw}`).slice(key.length + 1)
  if (SECRET_KEY.test(key) && !STATE_WORD.test(value)) return "[redacted]"
  return tokenLike(value) ? "…" : value
}

/** A long opaque run mixing cases and digits, or long hex; event kinds, ids and short hashes stay readable. */
function tokenLike(value: string): boolean {
  if (!OPAQUE_RUN.test(value)) return false
  return LONG_HEX.test(value) || (/\d/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value))
}

/** The report as compact text, one block per harness. */
export function formatReport(report: DoctorReport): string {
  return [
    `data ${report.logs} · last ${report.days} day${report.days === 1 ? "" : "s"} (since ${report.since})`,
    ...report.harnesses.map(formatHarness),
  ].join("\n\n")
}

function formatHarness(report: HarnessReport): string {
  const lines = [report.harness]
  const row = (label: string, text: string) => lines.push(`  ${label.padEnd(12)}${text}`)
  const more = (text: string) => lines.push(`  ${"".padEnd(12)}${text}`)

  const capabilities = report.families.filter((family) => family.status === "capability").map((family) => family.family)
  row("capability", capabilities.join(" "))
  for (const family of report.families.filter((entry) => entry.status !== "capability"))
    more(`${family.status === "lacks" ? "lacks" : "not built"} ${family.family}: ${family.reason}`)
  if (report.live) {
    const live = report.live
    LIVE_CAPABILITY_KEYS.forEach((key, index) => {
      const capability = live[key]
      const state = capability.state === "absent" ? `absent (${capability.by === "mako" ? "Mako gap" : "harness has none"})` : capability.state
      ;(index ? more : (text: string) => row("live", text))(`${LIVE_CAPABILITY_LABELS[key]}: ${state} · ${capabilityText(capability)}`)
    })
  } else row("live", "no live driver")

  const { installed, newestFixture, newestCaptured, verdict, sdk } = report.version
  const reading = installed.version ? `installed ${installed.version}${installed.from ? ` (${installed.from})` : ""}` : `installed: no version readable${installed.problem ? ` (${installed.problem})` : ""}`
  const fixtures = newestFixture ? `newest fixture ${newestFixture}${newestCaptured && newestCaptured !== newestFixture ? `, newest captured ${newestCaptured}` : newestCaptured ? " (captured)" : ", none captured"}` : "no fixture names a version"
  row("version", `${reading} · ${fixtures}`)
  if (verdict === "newer-than-fixtures") more("! installed is newer than every fixture: the next capture becomes the new fixture")
  if (verdict === "unreadable") more("! no installed version readable: fixtures can't be compared with what sessions run")
  if (sdk) more(`sdk ${sdk.installed.name} ${sdk.installed.version}${sdk.newestFixture ? ` · newest fixture ${sdk.newestFixture}` : " · no fixture names it"}${sdk.newer ? " ! newer than every fixture" : ""}`)

  const decoder = report.decoder
  if (decoder.absent) row("decoder", `none: ${decoder.absent}`)
  else {
    row("decoder", `${decoder.fixtures} fixture${decoder.fixtures === 1 ? "" : "s"} (${decoder.captured} captured, ${decoder.written} written) · ` +
      `${decoder.decodedKinds - decoder.unexercised.length}/${decoder.decodedKinds} decoded kinds exercised · ${decoder.silentKinds} silent kinds (${decoder.silentExercised} exercised)`)
    if (decoder.unexercised.length) more(`! decoded kinds with no fixture step: ${decoder.unexercised.join(", ")}`)
  }
  for (const name of decoder.invalid) more(`! ${name} is not a valid fixture (npm run test:decoders says why)`)

  const { tools } = report
  row("tools", tools.other.length
    ? `${tools.other.length} of ${tools.samples} samples ${tools.other.length === 1 ? "resolves" : "resolve"} to other: ${tools.other.map((tool) => `${tool.name}${tool.expected ? " (expected)" : ""}`).join(", ")}`
    : `${tools.samples} samples, none resolve to other`)

  const { logs } = report
  if (!logs.unknown) row("unknown", "none recorded (no native-unknown.jsonl)")
  else if (!logs.unknown.length) row("unknown", "none recorded")
  else {
    row("unknown", `${logs.unknown.length} kind${logs.unknown.length === 1 ? "" : "s"} kept in native-unknown.jsonl:`)
    for (const group of logs.unknown) more(`  ${group.kind}  ${group.reason} ×${group.count}  newest ${group.newest}${handledNote(group)}`)
  }
  row("host.log", logs.hostLog
    ? `${logs.hostLog.notHandled} not handled · ${logs.hostLog.unreadable} unreadable · ${logs.captures} capture${logs.captures === 1 ? "" : "s"} on disk`
    : `none recorded (no host.log) · ${logs.captures} capture${logs.captures === 1 ? "" : "s"} on disk`)
  const kinds = logs.hostLog?.kinds ?? []
  if (kinds.length) {
    // Kinds still open first: those are the ones to act on.
    const ordered = [...kinds.filter((entry) => !entry.handledBy), ...kinds.filter((entry) => entry.handledBy)]
    const shown = ordered.slice(0, HOST_KINDS_SHOWN).map((entry) => `${entry.kind}${entry.reason === "unreadable" ? " (unreadable)" : ""} ×${entry.count}${handledNote(entry)}`)
    more(`${shown.join(", ")}${kinds.length > HOST_KINDS_SHOWN ? `, +${kinds.length - HOST_KINDS_SHOWN} more` : ""}`)
  }
  const { signIn } = logs
  if (signIn) {
    if (!signIn.latest) row(signIn.scope, "none recorded")
    else {
      row(signIn.scope, `${signIn.count} line${signIn.count === 1 ? "" : "s"}; latest ${signIn.latest.at} ${signIn.latest.message}`)
      more(Object.entries(signIn.latest.fields).map(([key, value]) => `${key}=${value}`).join(" "))
    }
  }
  return lines.join("\n")
}

function handledNote(entry: { handledBy?: string }): string {
  return entry.handledBy ? ` (handled now: ${entry.handledBy})` : ""
}
