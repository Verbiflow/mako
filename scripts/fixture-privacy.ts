import { execFileSync } from "node:child_process"
import { readdir, readFile, stat, writeFile } from "node:fs/promises"
import { homedir, hostname, userInfo } from "node:os"
import { join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { z } from "zod"

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

/** One value that identifies the recording machine, how it's matched, and what stands for it. */
export interface Identity {
  kind: IdentityKind
  pattern: RegExp
  standIn: string
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

export function scrubIdentity(text: string, identity: readonly Identity[]): string {
  return identity.reduce((scrubbed, { pattern, standIn }) => scrubbed.replace(pattern, standIn), text)
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

/** Replaces the machine's identity in every text file and SQLite text value under `root`. Returns the files it changed. */
export async function scrubTree(root: string, identity: readonly Identity[]): Promise<string[]> {
  const changed: string[] = []
  for (const file of await filesUnder(root)) {
    if (file.endsWith(".db")) {
      if (scrubDatabase(file, identity)) changed.push(file)
    } else if (TEXT_FILE.test(file)) {
      const text = await readFile(file, "utf8")
      const scrubbed = scrubIdentity(text, identity)
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
    let changes = 0
    database.function("mako_scrub", { deterministic: true }, (value) => scrubIdentity(z.string().parse(value), identity))
    for (const { table, column } of databaseColumns(database))
      changes += Number(database.prepare(`UPDATE "${table}" SET "${column}" = mako_scrub("${column}") WHERE typeof("${column}") = 'text' AND mako_scrub("${column}") != "${column}"`).run().changes)
    if (changes) database.exec("VACUUM")
    return changes > 0
  } finally {
    database.close()
  }
}

/** What under `root` identifies someone, by file and kind. Binary files are read as bytes. */
export async function treeLeaks(root: string, identity: readonly Identity[]): Promise<Leak[]> {
  const leaks: Leak[] = []
  for (const file of await filesUnder(root)) {
    const kinds = new Set(leaksIn(relative(root, file), identity))
    if (file.endsWith(".db")) {
      const database = new DatabaseSync(file, { readOnly: true })
      try {
        for (const { table, column } of databaseColumns(database))
          for (const row of database.prepare(`SELECT CAST("${column}" AS TEXT) AS value FROM "${table}" WHERE typeof("${column}") IN ('text', 'blob')`).iterate())
            for (const kind of leaksIn(TextValue.parse(row).value ?? "", identity)) kinds.add(kind)
      } finally {
        database.close()
      }
    } else for (const kind of leaksIn(await readFile(file, TEXT_FILE.test(file) ? "utf8" : "latin1"), identity)) kinds.add(kind)
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
