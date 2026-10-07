import { execFileSync } from "node:child_process"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir, hostname, userInfo } from "node:os"
import { join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { isJsonObject, isString, type JsonValue } from "../electron/codex-app-json.ts"

/**
 * Fixtures are published with the source, so nothing in them may say whose
 * machine recorded them. A real CLI run under a sandboxed home still learns
 * the machine: Codex reports its host name (`remoteControl/status/changed`
 * `serverName`), and `ls -la` prints the file owner. `scrubTree` replaces the
 * recording machine's identity with stand-ins; `treeLeaks` names what is
 * left, by kind and file, never by value. `harness-decode-pairs.ts` runs both
 * on every pair it keeps, and `test-fixture-privacy.ts` checks every fixture.
 *
 *   npx tsx scripts/fixture-privacy.ts [--scrub] [folder…]
 */

export type IdentityKind = "home" | "email" | "host" | "user"

/** A global pattern and the text that replaces each match of it. */
export interface Substitution {
  pattern: RegExp
  standIn: string
}

/** One value that identifies the recording machine, how it's matched, and what stands for it. */
export interface Identity extends Substitution {
  kind: IdentityKind
}

export const STAND_INS = {
  home: "/Users/mako",
  email: "mako@example.invalid",
  host: "mako-pair-host",
  user: "mako",
} satisfies Record<IdentityKind, string>

/** Folders whose fixtures are published. */
export const FIXTURE_FOLDERS = ["scripts/fixtures", "packages/sessions/test/fixtures"]

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** A substitution of every occurrence of `text` itself. */
export function literally(text: string, standIn: string): Substitution {
  return { pattern: new RegExp(escape(text), "g"), standIn }
}

/**
 * The recording machine's identity, in the order it's replaced: a host name
 * often holds the user name ("Ana-MacBook"), so the host goes first. A value
 * too short to tell from ordinary words is left out.
 */
export function machineIdentity(): Identity[] {
  const identity: Identity[] = [{ kind: "home", pattern: new RegExp(escape(homedir()), "g"), standIn: STAND_INS.home }]
  const email = gitEmail()
  if (email) identity.push({ kind: "email", pattern: new RegExp(escape(email), "gi"), standIn: STAND_INS.email })
  const host = hostname().split(".")[0] ?? ""
  if (host.length >= 4) identity.push({ kind: "host", pattern: new RegExp(escape(host), "gi"), standIn: STAND_INS.host })
  const user = userInfo().username
  if (user.length >= 3) identity.push({ kind: "user", pattern: new RegExp(`\\b${escape(user)}\\b`, "gi"), standIn: STAND_INS.user })
  return identity
}

function gitEmail(): string | undefined {
  try {
    return execFileSync("git", ["config", "user.email"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || undefined
  } catch {
    return undefined
  }
}

export function scrubIdentity(text: string, identity: readonly Substitution[]): string {
  return identity.reduce((scrubbed, { pattern, standIn }) => scrubbed.replace(pattern, standIn), text)
}

interface Fragment {
  line: number
  text: string
  set: (text: string) => void
}

/**
 * Every string in a JSON Lines text, grouped into streams: strings at the
 * same key path beside the same `type`, in line order. A harness streams a
 * reply in fragments, and one fragment can end inside a path or a name
 * ("`/private/var/f") that the next one finishes, so only a stream read
 * whole shows it. Undefined when a line isn't JSON.
 */
function jsonStreams(text: string): { lines: JsonValue[]; streams: Fragment[][] } | undefined {
  const lines: JsonValue[] = []
  for (const line of text.split("\n")) {
    if (!line) continue
    try {
      lines.push(JsonLine.parse(JSON.parse(line)))
    } catch {
      return undefined
    }
  }
  const streams = new Map<string, Fragment[]>()
  const add = (path: string, fragment: Fragment) => {
    const stream = streams.get(path)
    if (stream) stream.push(fragment)
    else streams.set(path, [fragment])
  }
  const walk = (value: JsonValue, path: string, line: number): void => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (isString(item)) add(`${path}[]`, { line, text: item, set: (text) => { value[index] = text } })
        else walk(item, `${path}[]`, line)
      })
    } else if (isJsonObject(value)) {
      const type = value["type"]
      const kind = isString(type) ? `@${type}` : ""
      for (const [key, item] of Object.entries(value)) {
        if (isString(item)) add(`${path}.${key}${kind}`, { line, text: item, set: (text) => { value[key] = text } })
        else walk(item, `${path}.${key}`, line)
      }
    }
  }
  lines.forEach((value, line) => walk(value, "", line))
  return { lines, streams: [...streams.values()] }
}

/**
 * A JSON Lines text with each substitution applied to its streams read whole
 * (`jsonStreams`). A match that spans fragments is written whole into the
 * fragment it starts in and cut from the ones after, so the stream reads the
 * same once joined. Only changed lines are written again; a text with a line
 * that isn't JSON comes back unchanged.
 */
export function scrubJsonLines(text: string, substitutions: readonly Substitution[]): string {
  const read = jsonStreams(text)
  if (!read) return text
  const changed = new Set<number>()
  for (const stream of read.streams) for (const substitution of substitutions) substituteStream(stream, substitution, changed)
  if (!changed.size) return text
  let line = -1
  return text.split("\n").map((raw) => {
    if (!raw) return raw
    line += 1
    return changed.has(line) ? JSON.stringify(read.lines[line]) : raw
  }).join("\n")
}

function substituteStream(stream: Fragment[], { pattern, standIn }: Substitution, changed: Set<number>): void {
  const joined = stream.map((fragment) => fragment.text).join("")
  const matches = [...joined.matchAll(pattern)]
  if (!matches.length) return
  const ends: number[] = []
  for (const fragment of stream) ends.push((ends.at(-1) ?? 0) + fragment.text.length)
  const texts = stream.map(() => "")
  const copy = (from: number, to: number) => {
    stream.forEach((fragment, index) => {
      const start = (ends[index] ?? 0) - fragment.text.length
      const end = ends[index] ?? 0
      if (from < end && to > start) texts[index] += joined.slice(Math.max(from, start), Math.min(to, end))
    })
  }
  let at = 0
  for (const match of matches) {
    copy(at, match.index)
    const owner = ends.findIndex((end) => match.index < end)
    texts[owner] += standIn
    at = match.index + match[0].length
  }
  copy(at, joined.length)
  stream.forEach((fragment, index) => {
    const text = texts[index] ?? ""
    if (text === fragment.text) return
    fragment.text = text
    fragment.set(text)
    changed.add(fragment.line)
  })
}

/** Each stream of a JSON Lines text read whole, one per line; empty when a line isn't JSON. */
function streamTexts(text: string): string {
  return jsonStreams(text)?.streams.map((stream) => stream.map((fragment) => fragment.text).join("")).join("\n") ?? ""
}

/** Addresses a fixture may hold: a harness's own no-reply sender, and documentation domains. */
const ALLOWED_EMAIL = /^(?:noreply@anthropic\.com|[^@]+@example\.(?:com|org|net|invalid))$/i
/**
 * Home folders a fixture may name: the stand-in, the placeholders hand-written
 * fixtures use, xAI's build machine, which Grok's binary reports in its
 * built-in workflows' `workflowPath`, and the example paths in Devin's own
 * system prompt (`/home/ubuntu/repos/project`).
 */
const ALLOWED_HOME = /^\/(?:Users|home)\/(?:mako|me|user|ubuntu|admin\/actions-runner)\//
const STATIC_LEAKS: readonly { kind: string; pattern: RegExp; allowed?: RegExp }[] = [
  { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[a-z]{2,}/g, allowed: ALLOWED_EMAIL },
  { kind: "home path", pattern: /\/(?:Users|home)\/[A-Za-z0-9_-][A-Za-z0-9._-]*\/(?:[A-Za-z0-9._-]+\/)?/g, allowed: ALLOWED_HOME },
  { kind: "token", pattern: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{30,}|xox[abp]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}/g },
]

/** The kinds of identity `text` holds: the recording machine's own, and what is never a fixture's. */
export function leaksIn(text: string, identity: readonly Identity[]): string[] {
  const kinds = new Set<string>()
  for (const { kind, pattern } of identity) if (new RegExp(pattern.source, pattern.flags.replace("g", "")).test(text)) kinds.add(`machine ${kind}`)
  for (const { kind, pattern, allowed } of STATIC_LEAKS)
    for (const [match] of text.matchAll(pattern)) if (!allowed?.test(match)) kinds.add(kind)
  return [...kinds]
}

export interface Leak {
  file: string
  kinds: string[]
}

const TEXT_FILE = /\.(?:jsonl?|md|txt|ndjson|toml|ya?ml|csv|html?|ts|mjs|js)$/
const JsonLine: z.ZodType<JsonValue> = z.json()
const Tables = z.array(z.object({ name: z.string() }))
const Columns = z.array(z.object({ name: z.string() }))
const TextValue = z.object({ value: z.string().nullable() })

async function filesUnder(root: string): Promise<string[]> {
  const info = await stat(root).catch(() => null)
  if (!info) return []
  if (!info.isDirectory()) return [root]
  const nested = await Promise.all((await readdir(root)).map((entry) => filesUnder(join(root, entry))))
  return nested.flat()
}

function databaseColumns(database: DatabaseSync): { table: string; column: string }[] {
  const tables = Tables.parse(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all())
  return tables.flatMap(({ name }) => Columns.parse(database.prepare("SELECT name FROM pragma_table_info(?)").all(name)).map((column) => ({ table: name, column: column.name })))
}

/** Replaces the machine's identity in every text file, JSON Lines stream and SQLite value under `root`. Returns the files it changed. */
export async function scrubTree(root: string, identity: readonly Identity[]): Promise<string[]> {
  const changed: string[] = []
  for (const file of await filesUnder(root)) {
    if (file.endsWith(".db")) {
      if (scrubDatabase(file, identity)) changed.push(file)
    } else if (TEXT_FILE.test(file)) {
      const text = await readFile(file, "utf8")
      const whole = scrubIdentity(text, identity)
      const scrubbed = file.endsWith(".jsonl") ? scrubJsonLines(whole, identity) : whole
      if (scrubbed !== text) {
        await writeFile(file, scrubbed)
        changed.push(file)
      }
    }
  }
  return changed
}

function scrubDatabase(file: string, identity: readonly Identity[]): boolean {
  const database = new DatabaseSync(file)
  try {
    const changes = rewriteDatabase(database, (text) => scrubIdentity(text, identity), identity)
    if (changes) database.exec("VACUUM")
    return changes > 0
  } finally {
    database.close()
  }
}

const BlobRow = z.object({ row: z.number(), value: z.instanceof(Uint8Array) })
const strict = new TextDecoder("utf-8", { fatal: true })

/**
 * Applies `rewrite` to every text value, and the text inside every binary
 * value (`rewriteBlob`), in `database`, then `substitutions` to each column of
 * JSON rows read as one JSON Lines stream (`scrubJsonLines`): Cursor's
 * `run_events` keeps a reply as one message per fragment, a row each. Returns
 * the rows it changed.
 */
export function rewriteDatabase(database: DatabaseSync, rewrite: (text: string) => string, substitutions: readonly Substitution[] = []): number {
  let changes = 0
  database.function("mako_rewrite", { deterministic: true }, (value) => rewrite(z.string().parse(value)))
  for (const { table, column } of databaseColumns(database)) {
    changes += Number(database.prepare(`UPDATE "${table}" SET "${column}" = mako_rewrite("${column}") WHERE typeof("${column}") = 'text' AND mako_rewrite("${column}") != "${column}"`).run().changes)
    const update = database.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`)
    for (const row of database.prepare(`SELECT rowid AS row, "${column}" AS value FROM "${table}" WHERE typeof("${column}") = 'blob'`).all()) {
      const { row: id, value } = BlobRow.parse(row)
      const rewritten = rewriteBlob(value, rewrite)
      if (rewritten !== value) changes += Number(update.run(rewritten, id).changes)
    }
    if (!substitutions.length) continue
    const rows = columnLines(database, table, column)
    if (!rows.length) continue
    const scrubbed = scrubJsonLines(rows.map(({ value }) => value).join("\n"), substitutions).split("\n")
    if (scrubbed.length !== rows.length) continue
    rows.forEach(({ row, value }, index) => {
      const text = scrubbed[index]
      if (text !== undefined && text !== value) changes += Number(update.run(text, row).changes)
    })
  }
  return changes
}

const TextRow = z.object({ row: z.number(), value: z.string() })

/** A column's one-line text values in row order: the lines of a JSON Lines stream when each holds a JSON value. */
function columnLines(database: DatabaseSync, table: string, column: string): z.infer<typeof TextRow>[] {
  const rows = database.prepare(`SELECT rowid AS row, "${column}" AS value FROM "${table}" WHERE typeof("${column}") = 'text' AND instr("${column}", char(10)) = 0 ORDER BY rowid`).all()
  return rows.map((row) => TextRow.parse(row))
}

/**
 * A binary value with `rewrite` applied to the text inside it, or the same
 * value when nothing changed. Cursor's `blobs` keep protobuf records and JSON
 * messages side by side: a protobuf has each string rewritten and the lengths
 * around it encoded again, and anything else that is UTF-8 is rewritten whole.
 */
export function rewriteBlob(value: Uint8Array, rewrite: (text: string) => string): Uint8Array {
  const message = rewriteMessage(value, rewrite)
  if (message) return message === value ? value : message
  const text = utf8(value)
  if (text === undefined) return value
  const rewritten = rewrite(text)
  return rewritten === text ? value : Buffer.from(rewritten)
}

function utf8(value: Uint8Array): string | undefined {
  try {
    return strict.decode(value)
  } catch {
    return undefined
  }
}

/** `value` rewritten as a protobuf message; the same value when nothing changed, undefined when it isn't one. */
function rewriteMessage(value: Uint8Array, rewrite: (text: string) => string): Uint8Array | undefined {
  const parts: Uint8Array[] = []
  let changed = false
  let at = 0
  const varint = (): number | undefined => {
    let result = 0
    for (let shift = 0; shift < 64; shift += 7) {
      const byte = value[at++]
      if (byte === undefined) return undefined
      result += (byte & 0x7f) * 2 ** shift
      if (!(byte & 0x80)) return result
    }
    return undefined
  }
  while (at < value.length) {
    const start = at
    const tag = varint()
    if (tag === undefined || tag < 8) return undefined
    const wire = tag & 7
    if (wire === 0) {
      if (varint() === undefined) return undefined
    } else if (wire === 1 || wire === 5) {
      at += wire === 1 ? 8 : 4
      if (at > value.length) return undefined
    } else if (wire === 2) {
      const length = varint()
      if (length === undefined || at + length > value.length) return undefined
      const field = value.subarray(at, at + length)
      at += length
      const rewritten = rewriteField(field, rewrite)
      if (rewritten !== field) {
        changed = true
        parts.push(value.subarray(start, at - length - lengthBytes(length)), encodeVarint(rewritten.length), rewritten)
        continue
      }
    } else return undefined
    parts.push(value.subarray(start, at))
  }
  return changed ? Buffer.concat(parts) : value
}

/**
 * A length-delimited field: a nested message when it starts with a field tag
 * (every tag of fields 1 to 3 is below 0x20, and no text starts that way),
 * else text when it is UTF-8, else bytes left alone.
 */
function rewriteField(field: Uint8Array, rewrite: (text: string) => string): Uint8Array {
  const first = field[0]
  if (first !== undefined && first < 0x20) {
    const message = rewriteMessage(field, rewrite)
    if (message) return message
  }
  const text = utf8(field)
  if (text === undefined) return field
  const rewritten = rewrite(text)
  return rewritten === text ? field : Buffer.from(rewritten)
}

function lengthBytes(length: number): number {
  return encodeVarint(length).length
}

function encodeVarint(value: number): Uint8Array {
  const bytes: number[] = []
  let rest = value
  while (rest >= 0x80) {
    bytes.push((rest % 0x80) | 0x80)
    rest = Math.floor(rest / 0x80)
  }
  bytes.push(rest)
  return Uint8Array.from(bytes)
}

/** What under `root` identifies someone, by file and kind. Binary files are read as bytes; JSON Lines files and columns of JSON rows also stream by stream. */
export async function treeLeaks(root: string, identity: readonly Identity[]): Promise<Leak[]> {
  const leaks: Leak[] = []
  for (const file of await filesUnder(root)) {
    const kinds = new Set(leaksIn(relative(root, file), identity))
    if (file.endsWith(".db")) {
      const database = new DatabaseSync(file, { readOnly: true })
      try {
        for (const { table, column } of databaseColumns(database)) {
          for (const row of database.prepare(`SELECT CAST("${column}" AS TEXT) AS value FROM "${table}" WHERE typeof("${column}") IN ('text', 'blob')`).iterate())
            for (const kind of leaksIn(TextValue.parse(row).value ?? "", identity)) kinds.add(kind)
          const lines = columnLines(database, table, column).map(({ value }) => value).join("\n")
          for (const kind of leaksIn(streamTexts(lines), identity)) kinds.add(kind)
        }
      } finally {
        database.close()
      }
    } else {
      const text = await readFile(file, TEXT_FILE.test(file) ? "utf8" : "latin1")
      for (const kind of leaksIn(text, identity)) kinds.add(kind)
      if (file.endsWith(".jsonl")) for (const kind of leaksIn(streamTexts(text), identity)) kinds.add(kind)
    }
    if (kinds.size) leaks.push({ file, kinds: [...kinds].sort() })
  }
  return leaks
}

export function describeLeaks(leaks: readonly Leak[], from = process.cwd()): string {
  return leaks.map(({ file, kinds }) => `  ${relative(from, file)}: ${kinds.join(", ")}`).join("\n")
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2)
  const scrub = args.includes("--scrub")
  const folders = args.filter((arg) => arg !== "--scrub")
  const identity = machineIdentity()
  const roots = folders.length ? folders : FIXTURE_FOLDERS
  if (scrub) for (const root of roots) for (const file of await scrubTree(root, identity)) console.log(`scrubbed ${relative(process.cwd(), file)}`)
  const leaks = (await Promise.all(roots.map((root) => treeLeaks(root, identity)))).flat()
  if (leaks.length) {
    console.error(`${leaks.length} fixture files identify someone (values not printed):\n${describeLeaks(leaks)}`)
    process.exit(1)
  }
  console.log(`No fixture under ${roots.join(", ")} identifies the recording machine or anyone else`)
}
