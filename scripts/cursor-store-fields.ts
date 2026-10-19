import { spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { compareVersions } from "../packages/sessions/src/runtime-version.ts"

/**
 * What "newer" means between a `cursor-agent` build and the Cursor SDK that
 * imports its stores, read from the code of each: the fields of every message
 * a `cursor-agent` store's blobs hold, as each build's and each SDK
 * release's generated protobuf classes declare them. A build whose store
 * messages have a field an SDK lacks writes what that SDK doesn't read,
 * unless a later build dropped the field too.
 *
 * Read-only: the builds are read where `cursor-agent` installed them
 * (`~/.local/share/cursor-agent/versions/<build>/`), the bundled SDK from
 * `node_modules`, and each other SDK release from its npm tarball, fetched
 * into a temporary folder and removed after. `--write` keeps the fields in
 * `packages/sessions/test/fixtures/cursor-store-fields.json`, which
 * `test/record-evidence.mjs` holds the restore gate's rule to.
 *
 *   npx tsx scripts/cursor-store-fields.ts --sdk 1.0.31,1.0.32,1.0.34,1.0.35,1.0.36,1.0.37,1.0.38 [--write]
 */

const { values: options } = parseArgs({ options: { sdk: { type: "string" }, write: { type: "boolean", default: false } } })

/** The messages a `cursor-agent` store's blobs hold: the root, its turns and their steps, summaries, plans and subagents. */
const STORE_MESSAGES = [
  "ConversationStateStructure", "ConversationTurnStructure", "AgentConversationTurnStructure", "ConversationStep", "UserMessage",
  "AssistantMessage", "ThinkingMessage", "ConversationSummary", "ConversationSummaryArchive", "ConversationTokenDetails",
  "SubagentPersistedState", "ConversationPlan", "ToolCall",
]

type Fields = Record<string, number[]>

/** The store messages' field numbers in a folder of bundled JavaScript, in either generated form: `cursor-agent`'s compact `["Name|1 a 12*|…"]` or protobuf-es's `typeName="agent.v1.Name",X.fields=…newFieldList(()=>[{no:1,…}])`. */
function storeFields(folder: string): Fields {
  const found = new Map<string, Set<number>>()
  const add = (name: string, numbers: number[]) => {
    if (!STORE_MESSAGES.includes(name)) return
    const held = found.get(name) ?? new Set<number>()
    for (const number of numbers) held.add(number)
    found.set(name, held)
  }
  for (const file of readdirSync(folder)) {
    if (!file.endsWith(".js")) continue
    const text = readFileSync(join(folder, file), "latin1")
    for (const match of text.matchAll(/\["([A-Z][A-Za-z0-9_]*)\|([^"\]]*)"/g)) add(match[1]!, match[2]!.split("|").map((field) => Number(field.split(" ")[0])).filter(Number.isInteger))
    for (const match of text.matchAll(/typeName="agent\.v1\.([A-Za-z0-9_]+)",[A-Za-z0-9_$]+\.fields=[A-Za-z0-9_$.]+util\.newFieldList\(\(\(\)=>\[(.*?)\]\)\)/g))
      add(match[1]!, [...match[2]!.matchAll(/\{no:(\d+),name:"/g)].map((field) => Number(field[1])))
  }
  return Object.fromEntries([...found].sort(([a], [b]) => a.localeCompare(b)).map(([name, numbers]) => [name, [...numbers].sort((a, b) => a - b)]))
}

const TimesSchema = z.object({ time: z.record(z.string(), z.string()) })
const times = TimesSchema.parse(await (await fetch("https://registry.npmjs.org/@cursor%2Fsdk", { signal: AbortSignal.timeout(10_000) })).json()).time

const root = resolve(import.meta.dirname, "..")
const bundled = z.object({ version: z.string() }).parse(JSON.parse(readFileSync(join(root, "node_modules/@cursor/sdk/package.json"), "utf8"))).version
const sdks = new Map<string, { published: string; fields: Fields }>()
const scratch = mkdtempSync(join(tmpdir(), "mako-sdk-fields-"))
try {
  for (const version of new Set([bundled, ...(options.sdk?.split(",").map((each) => each.trim()).filter(Boolean) ?? [])])) {
    const published = times[version]
    if (!published) throw new Error(`npm has no @cursor/sdk ${version}`)
    let folder = join(root, "node_modules/@cursor/sdk/dist/esm")
    if (version !== bundled) {
      const tarball = join(scratch, `sdk-${version}.tgz`)
      const response = await fetch(`https://registry.npmjs.org/@cursor/sdk/-/sdk-${version}.tgz`, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) throw new Error(`npm answered ${response.status} for @cursor/sdk ${version}`)
      writeFileSync(tarball, Buffer.from(await response.arrayBuffer()))
      const into = join(scratch, version)
      spawnSync("mkdir", ["-p", into])
      const untar = spawnSync("tar", ["-xzf", tarball, "-C", into])
      if (untar.status !== 0) throw new Error(`tar couldn't open @cursor/sdk ${version}: ${untar.stderr.toString()}`)
      folder = join(into, "package/dist/esm")
    }
    sdks.set(version, { published, fields: storeFields(folder) })
  }
} finally {
  rmSync(scratch, { recursive: true, force: true })
}

const installs = join(homedir(), ".local/share/cursor-agent/versions")
const builds = new Map<string, Fields>()
for (const build of existsSync(installs) ? readdirSync(installs).sort(compareVersions) : []) builds.set(build, storeFields(join(installs, build)))
if (!builds.size) throw new Error(`no cursor-agent build is installed under ${installs}`)

/** A build's fields that a later build no longer has: dropped, so an SDK lacking them reads the store as that later build would. */
function dropped(build: string): Set<string> {
  const later = [...builds.keys()].filter((each) => compareVersions(each, build) > 0)
  const gone = new Set<string>()
  for (const [message, numbers] of Object.entries(builds.get(build)!))
    for (const number of numbers) if (later.some((each) => !builds.get(each)![message]?.includes(number))) gone.add(`${message}.${number}`)
  return gone
}

const day = (iso: string) => new Date(iso).toISOString().slice(0, 10).replaceAll("-", ".")
console.log(`${"SDK".padEnd(8)} ${"published".padEnd(11)} ${"build".padEnd(20)} rule      fields the build writes that the SDK lacks (dropped later in parentheses)`)
for (const [version, sdk] of [...sdks].sort(([a], [b]) => compareVersions(a, b))) {
  for (const [build, fields] of builds) {
    const gone = dropped(build)
    const lacks: string[] = []
    for (const [message, numbers] of Object.entries(fields)) {
      const has = sdk.fields[message]
      for (const number of numbers) if (!has?.includes(number)) lacks.push(gone.has(`${message}.${number}`) ? `(${message}.${number})` : `${message}.${number}`)
    }
    const rule = compareVersions(build, day(sdk.published)) <= 0 ? "reads" : "gated"
    console.log(`${version.padEnd(8)} ${day(sdk.published).padEnd(11)} ${build.padEnd(20)} ${rule.padEnd(9)} ${lacks.join(" ") || "none"}`)
  }
}

if (options.write) {
  const file = join(root, "packages/sessions/test/fixtures/cursor-store-fields.json")
  writeFileSync(file, `${JSON.stringify({
    read: new Date().toISOString().slice(0, 10),
    messages: STORE_MESSAGES,
    sdk: Object.fromEntries([...sdks].sort(([a], [b]) => compareVersions(a, b))),
    builds: Object.fromEntries(builds),
  }, null, 1)}\n`)
  console.log(`\nKept in ${file}`)
}
