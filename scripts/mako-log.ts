/**
 * Mako's log of one conversation, oldest first: what Mako did in it, each
 * event the one change it made. Reads the journal without writing it, so it
 * runs beside the host that owns it.
 *
 *   npm run mako-log -- <conversation id | journal file> [--data-root <dir>] [--kind <prefix>] [--json] [--facts]
 *
 * `--kind request` keeps a kind and its changes; `--json` prints the events
 * whole; `--facts` prints what the log folds to, as the journal's rows hold it.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { resolveHostEnvironment } from "@mako/host/base/host-environment"
import { foldMakoLog } from "@mako/host/conversations/mako-log"
import type { JsonValue } from "@mako/host/contracts/json"

const args = process.argv.slice(2)
function option(name: string): string | undefined {
  const at = args.indexOf(name)
  if (at < 0) return undefined
  const value = args[at + 1]
  args.splice(at, 2)
  return value
}
function flag(name: string): boolean {
  const at = args.indexOf(name)
  if (at >= 0) args.splice(at, 1)
  return at >= 0
}
const dataRoot = option("--data-root")
const kind = option("--kind")
const json = flag("--json")
const facts = flag("--facts")
const [target] = args
if (!target) {
  console.error("usage: mako-log <conversation id | journal file> [--data-root <dir>] [--kind <prefix>] [--json] [--facts]")
  process.exit(2)
}

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const env = { ...process.env }
if (dataRoot) env.MAKO_DATA_ROOT = dataRoot
const path = target.endsWith(".sqlite") ? target : join(resolveHostEnvironment({ env, appRoot, platform: process.platform, home: homedir() }).dataRoot, "conversations", `${target}.sqlite`)
if (!existsSync(path)) {
  console.error(`No journal at ${path}. Pass a journal file, or --data-root for another data folder.`)
  process.exit(1)
}

const RowSchema = z.object({ seq: z.number(), at: z.number(), kind: z.string(), value: z.string(), origin: z.enum(["host", "journal"]), schema: z.number() })
const db = new DatabaseSync(path, { readOnly: true })
let rows: z.infer<typeof RowSchema>[]
try {
  const table = db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'log'").get()
  if (!table) {
    console.log(`${path} has no log yet: Mako takes the journal's facts into one the next time it opens the conversation.`)
    process.exit(0)
  }
  rows = db.prepare("SELECT seq, at, kind, value, origin, schema FROM log ORDER BY seq").all().map((row) => RowSchema.parse(row))
} finally {
  db.close()
}

const events = rows.map((row) => ({ ...row, value: z.record(z.string(), z.json()).parse(JSON.parse(row.value)) }))
if (facts) {
  console.log(JSON.stringify(foldMakoLog(events).facts(), null, 2))
  process.exit(0)
}
const shown = kind ? events.filter((event) => event.kind === kind || event.kind.startsWith(`${kind}.`)) : events
if (json) {
  for (const event of shown) console.log(JSON.stringify(event))
  process.exit(0)
}

const short = (value: JsonValue, limit = 80) => {
  const text = z.string().safeParse(value).data ?? JSON.stringify(value)
  const line = text.replace(/\s+/gu, " ")
  return line.length > limit ? `${line.slice(0, limit)}… (${text.length} chars)` : line
}
const ChangeSchema = z.object({ key: z.string().optional(), set: z.record(z.string(), z.json()).optional(), unset: z.array(z.string()).optional() })
const ItemSchema = z.looseObject({ id: z.string().optional(), input: z.looseObject({ id: z.string() }).optional(), status: z.string().optional(), text: z.string().optional(), state: z.looseObject({ kind: z.string() }).optional() })
/** What an event changed, on one line. */
function summary(event: (typeof events)[number]): string {
  const change = ChangeSchema.safeParse(event.value).data
  if (!change?.set && !change?.unset) {
    const item = ItemSchema.safeParse(event.value).data
    const id = item?.id ?? item?.input?.id
    const state = item?.status ?? item?.state?.kind
    const parts = [id, state, item?.text === undefined ? undefined : short(item.text, 60)].filter((part) => part !== undefined)
    return parts.length ? parts.join("  ") : short(event.value.keys ?? event.value.key ?? event.value, 120)
  }
  const fields = [
    ...Object.entries(change.set ?? {}).map(([name, value]) => `${name}=${short(value)}`),
    ...(change.unset ?? []).map((name) => `-${name}`),
  ]
  return [change.key, ...fields].filter((part) => part !== undefined).join("  ")
}

const counts = new Map<string, number>()
for (const event of events) counts.set(event.origin, (counts.get(event.origin) ?? 0) + 1)
console.log(`${path}\n${events.length} events (${[...counts].map(([origin, count]) => `${count} ${origin === "host" ? "logged as Mako acted" : "taken in from the journal's rows"}`).join(", ")}), ${(rows.reduce((total, row) => total + row.value.length, 0) / 1024).toFixed(1)} KiB${kind ? `; showing ${shown.length} of kind ${kind}` : ""}\n`)
let day = ""
for (const event of shown) {
  const at = new Date(event.at)
  const date = at.toLocaleDateString("en-CA")
  if (date !== day) {
    day = date
    console.log(date)
  }
  const time = at.toLocaleTimeString("en-GB", { hour12: false }) + `.${String(at.getMilliseconds()).padStart(3, "0")}`
  console.log(`  ${String(event.seq).padStart(5)}  ${time}  ${event.origin === "journal" ? "~" : " "} ${event.kind.padEnd(28)} ${summary(event)}`)
}
if (counts.get("journal")) console.log(`\n~ taken in from the journal's rows: facts from before the log, or a build that wrote them without it`)
