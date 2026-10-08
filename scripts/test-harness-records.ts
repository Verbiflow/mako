import { execFile } from "node:child_process"
import { mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import {
  CLAUDE_ATTACHMENT_TYPES, CLAUDE_RECORD_TYPES, CLAUDE_SYSTEM_SUBTYPES,
  CODEX_EVENTS, CODEX_EXTENSIONS, CODEX_RESPONSE_ITEMS, CODEX_RETIRED_RESPONSE_ITEMS, CODEX_ROLLOUT_ITEMS, CODEX_TURN_ITEMS,
  CURSOR_MESSAGE_PARTS,
  OPENCODE_ASSISTANT_CONTENT, OPENCODE_LEGACY_PARTS, OPENCODE_MESSAGES,
} from "../packages/sessions/src/harnesses/index.ts"
import { resolveExecutable } from "../electron/executable.ts"
import { resolveCodexExecutable } from "../electron/providers/codex/executable.ts"
import { claudeSdkBinary, codexBinary } from "./harness-binaries.ts"

/**
 * Each harness's record tables (`packages/sessions/src/harnesses/`) against
 * the build Mako runs: every kind of record that build can save is one
 * history reads, skips or declares undrawn, so an upgrade that adds one
 * fails here by name instead of reaching a saved thread as an unknown
 * record. Kinds a table keeps that the build doesn't name are listed, not
 * failed: sessions from other builds hold them.
 *
 * Claude, OpenCode and Cursor are checked both ways from the tables in their
 * own builds. Codex's response items come from its generated protocol
 * schema; its events, turn items and extensions have no listing outside
 * Rust, so each declared name must still be in the binary. Grok's and
 * Devin's saved ACP updates are held to the SDK's union at compile time
 * (`ACP_SAVED_UPDATES`); a kind of their own surfaces through
 * `harness:doctor`.
 *
 * Another build of a harness, before upgrading to it:
 *
 *   tsx scripts/test-harness-records.ts codex=<binary> claude=<binary> opencode=<binary>
 */

const run = promisify(execFile)
const failures: string[] = []
const notes: string[] = []
const checked: string[] = []
const builds = new Map(process.argv.slice(2).map((arg) => {
  const [harness, path] = arg.split("=")
  if (!harness || !path || !["claude", "codex", "opencode"].includes(harness)) throw new Error(`${arg}: expected claude=, codex= or opencode= and a binary`)
  return [harness, path]
}))

async function build(path: string): Promise<string> {
  return (await readFile(path)).toString("latin1")
}

function matches(text: string, pattern: RegExp): Set<string> {
  return new Set([...text.matchAll(pattern)].map((match) => match[1]!))
}

/** Every kind the build names is in the table, or written nowhere a session keeps. */
function compare(where: string, built: ReadonlySet<string>, declared: Iterable<string>, unsaved: Readonly<Record<string, string>> = {}): void {
  if (!built.size) return void failures.push(`${where}: none found in the build, so the extraction no longer matches it`)
  const known = new Set(declared)
  const added = [...built].filter((name) => !known.has(name) && !Object.hasOwn(unsaved, name)).sort()
  const gone = [...known].filter((name) => !built.has(name)).sort()
  if (added.length) failures.push(`${where}: the build names ${added.join(", ")}, which the table doesn't place`)
  if (gone.length) notes.push(`${where}: this build doesn't name ${gone.join(", ")}, which another build's sessions may hold`)
}

async function version(executable: string, args = ["--version"]): Promise<string> {
  const { stdout } = await run(executable, args, { timeout: 20_000 })
  return /\d+(?:\.\d+)+(?:-[\w.-]+)?/.exec(stdout)?.[0] ?? stdout.trim()
}

async function claude(): Promise<void> {
  const binary = builds.get("claude") ?? claudeSdkBinary()
  const text = await build(binary)
  const loader = /\{user:"transcript",assistant:"transcript"[^}]*\}/.exec(text)?.[0] ?? ""
  compare("claude records", new Set([...loader.matchAll(/(?:"([a-z-]+)"|\b([a-z]+)):"/g)].map((match) => match[1] ?? match[2]!)), CLAUDE_RECORD_TYPES)
  compare("claude system subtypes", matches(text, /type:"system",subtype:"([a-z_]+)"/g), CLAUDE_SYSTEM_SUBTYPES)
  const attachments = matches(text, /attachment\.type[!=]==?"([a-z_]+)"/g)
  for (const [, list] of text.matchAll(/\[((?:"[a-z_]+",(?:\.\.\.\[\],)?)+"[a-z_]+")\]/g)) {
    const names = [...list!.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!)
    if (names.some((name) => name === "skill_listing" || name === "queued_command" || name === "remote_session_change"))
      for (const name of names) attachments.add(name)
  }
  compare("claude attachments", attachments, CLAUDE_ATTACHMENT_TYPES)
  checked.push(`Claude Code ${await version(binary)}`)
}

/** Response items Codex's rollout policy never writes (`codex-rs/rollout/src/policy.rs`). */
const CODEX_UNSAVED = {
  additional_tools: "tools offered to the model for one request",
  compaction_trigger: "a request to compact, answered by the compaction",
  other: "serde's catch-all for a type this Codex doesn't know",
} satisfies Record<string, string>

async function codex(): Promise<void> {
  const launcher = builds.get("codex") ?? await resolveCodexExecutable()
  const binary = builds.get("codex") ?? await codexBinary()
  if (!launcher || !binary) return void notes.push("codex is not installed; its tables went unchecked")
  const out = await mkdtemp(join(tmpdir(), "mako-codex-schema-"))
  try {
    await run(launcher, ["app-server", "generate-json-schema", "--out", out], { timeout: 60_000 })
    const Schema = z.object({ definitions: z.object({
      ResponseItem: z.object({ oneOf: z.array(z.object({ properties: z.object({ type: z.object({ enum: z.array(z.string()) }) }) })) }),
    }) })
    const schema = Schema.parse(JSON.parse(await readFile(join(out, "codex_app_server_protocol.v2.schemas.json"), "utf8")))
    const items = new Set(schema.definitions.ResponseItem.oneOf.flatMap((option) => option.properties.type.enum))
    compare("codex response items", items, Object.keys(CODEX_RESPONSE_ITEMS), CODEX_UNSAVED)
    const retired = Object.keys(CODEX_RETIRED_RESPONSE_ITEMS).filter((name) => items.has(name))
    if (retired.length) failures.push(`codex response items: ${retired.join(", ")} ${retired.length === 1 ? "is" : "are"} listed as retired but the schema still defines ${retired.length === 1 ? "it" : "them"}`)
  } finally {
    await rm(out, { recursive: true, force: true })
  }
  const text = await build(binary)
  for (const [table, readings] of [
    ["rollout items", CODEX_ROLLOUT_ITEMS],
    ["events", CODEX_EVENTS],
    ["turn items", CODEX_TURN_ITEMS],
    ["extensions", CODEX_EXTENSIONS],
  ] as const) {
    const missing = Object.entries(readings).filter(([name]) => !text.includes(name))
    const read = missing.filter(([, reading]) => reading === "read").map(([name]) => name)
    const other = missing.filter(([, reading]) => reading !== "read").map(([name]) => name)
    if (read.length) failures.push(`codex ${table}: the binary doesn't name ${read.join(", ")}, which history reads; a rename leaves it reading nothing`)
    if (other.length) notes.push(`codex ${table}: this build doesn't name ${other.join(", ")}, which another build's sessions may hold`)
  }
  checked.push(`Codex ${await version(launcher)}`)
}

/** The `type` literal of each schema the build annotates with an identifier matching `pattern`. */
function annotatedTypes(text: string, pattern: RegExp): Map<string, string> {
  const types = new Map<string, string>()
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index - 2500), match.index - "}).annotate({".length)
    const start = Math.max(before.lastIndexOf(".annotate("), before.lastIndexOf("identifier:"))
    const type = /\btype:\w{1,3}\("([a-z-]+)"\)/.exec(start >= 0 ? before.slice(start + 1) : before)?.[1]
    if (type) types.set(match[1]!, type)
  }
  return types
}

async function opencode(): Promise<void> {
  const executable = builds.get("opencode") ?? resolveExecutable("opencode", process.env)
  if (!executable) return void notes.push("opencode is not installed; its tables went unchecked")
  const text = await build(await realpath(executable))
  const current = annotatedTypes(text, /identifier:"Session\.Message\.([A-Za-z.]+)"/g)
  const content = new Set([...current].filter(([name]) => name.startsWith("Assistant.")).map(([, type]) => type))
  const messages = new Set([...current].filter(([name]) => !name.startsWith("Assistant.")).map(([, type]) => type))
  compare("opencode messages", messages, Object.keys(OPENCODE_MESSAGES))
  compare("opencode assistant content", content, OPENCODE_ASSISTANT_CONTENT)
  compare("opencode legacy parts", new Set(annotatedTypes(text, /identifier:"SessionV1\.(\w+Part)"/g).values()), Object.keys(OPENCODE_LEGACY_PARTS))
  checked.push(`OpenCode ${await version(executable)}`)
}

/** The parts the SDK's own transcript reader switches on, beside `redacted-reasoning`. */
async function cursor(): Promise<void> {
  const root = new URL("../node_modules/@cursor/sdk/", import.meta.url)
  const { version: sdk } = z.object({ version: z.string() }).parse(JSON.parse(await readFile(new URL("package.json", root), "utf8")))
  const cjs = new URL("dist/cjs/", root).pathname
  const parts = new Set<string>()
  for (const name of (await readdir(cjs)).filter((file) => file.endsWith(".js"))) {
    const text = await readFile(join(cjs, name), "utf8")
    for (const match of text.matchAll(/case"redacted-reasoning":/g)) {
      const start = text.lastIndexOf("switch(", match.index)
      const end = text.indexOf("}", text.indexOf('case"tool-result"', match.index))
      if (start < 0 || end < 0) continue
      for (const [, part] of text.slice(start, end).matchAll(/case"([a-z-]+)":/g)) parts.add(part!)
    }
  }
  compare("cursor message parts", parts, new Set(Object.values(CURSOR_MESSAGE_PARTS).flat()))
  checked.push(`Cursor SDK ${sdk}`)
}

await claude()
await codex()
await opencode()
if (!builds.size) await cursor()

for (const note of notes) console.log(`note: ${note}`)
if (failures.length) {
  console.error(`\n${failures.map((failure) => `✗ ${failure}`).join("\n")}\n`)
  console.error("Place each new kind in its harness's table as read, skipped or undrawn, with why, and teach its reader any it reads.")
  process.exit(1)
}
console.log(`PASS: every record ${checked.join(", ")} can save is one its history reader places`)
