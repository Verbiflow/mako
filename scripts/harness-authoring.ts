import { join, resolve } from "node:path"
import { parseArgs } from "node:util"
import { z } from "zod"
import { NativeAuthoringFamilySchema, type AuthoringChange, type AuthoringEntry, type AuthoringView } from "@mako/host/contracts/native-authoring"
import { nativeAuthoring } from "@mako/host/tools/native-authoring"
import { AuthoringFiles } from "@mako/host/tools/authoring-files"
import { unifiedDiff } from "@mako/host/tools/authoring-text"
import { authoringBackups } from "@mako/host/tools/index"
import { createHarnessHost, detachedHarnessContext } from "@mako/host/harnesses/harness-host"
import { toolHarnesses } from "@mako/host/harnesses/tool-harnesses"
import { NativeStores } from "@mako/sessions/read-only-sqlite"
import { defaultDataDir } from "./harness-doctor-report.ts"

/**
 * A harness's hooks, commands or MCP servers as Mako reads them, and the
 * exact diff a change would write. Nothing is written without `--apply`;
 * an applied change keeps the file as it was in Mako's backups first.
 *
 *   npm run harness:authoring -- codex hooks                       every source and entry, in Codex's order
 *   npm run harness:authoring -- codex hooks --json
 *   npm run harness:authoring -- codex hooks --off "PreToolUse · Bash"     the diff that turns it off
 *   npm run harness:authoring -- grok mcp --remove docs --apply
 *   npm run harness:authoring -- claude hooks --create <source id> --draft '{"kind":"hook","event":"Stop","type":"command","run":"say done"}'
 *
 * `--on`, `--off`, `--remove` and `--trust` take an entry's id or its name
 * as listed; `--cwd` chooses the project (where the command was typed, by
 * default).
 */

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    cwd: { type: "string" },
    json: { type: "boolean", default: false },
    on: { type: "string" },
    off: { type: "string" },
    remove: { type: "string" },
    trust: { type: "string" },
    create: { type: "string" },
    edit: { type: "string" },
    draft: { type: "string" },
    apply: { type: "boolean", default: false },
    "data-dir": { type: "string" },
  },
})

const [provider, familyName] = positionals
const family = NativeAuthoringFamilySchema.safeParse(familyName)
if (!provider || !family.success) {
  console.error("Usage: npm run harness:authoring -- <harness> <hooks|commands|mcp> [--off|--on|--remove|--trust <entry>] [--create <source> --draft <json>] [--apply]")
  process.exit(2)
}
const cwd = resolve(options.cwd ?? process.env.INIT_CWD ?? process.cwd())
const host = createHarnessHost(detachedHarnessContext(new NativeStores(false)))
const authoring = nativeAuthoring(toolHarnesses(host), new AuthoringFiles(authoringBackups(options["data-dir"] ?? defaultDataDir())))
const target = { provider, family: family.data, cwd }

const Draft = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hook"), event: z.string(), matcher: z.string().optional(), type: z.string(), run: z.string(), timeout: z.number().optional() }),
  z.object({ kind: z.literal("command"), invocation: z.string(), text: z.string() }),
  z.object({ kind: z.literal("module"), name: z.string(), text: z.string() }),
])

function entry(view: AuthoringView, key: string): AuthoringEntry {
  const byId = view.entries.find((candidate) => candidate.id === key)
  if (byId) return byId
  const named = view.entries.filter((candidate) => candidate.name === key)
  if (named.length === 1 && named[0]) return named[0]
  console.error(named.length ? `${named.length} entries are named ${key}; give one's id:` : `No entry is named ${key}. Entries:`)
  for (const candidate of named.length ? named : view.entries) console.error(`  ${candidate.name}  ${candidate.id}`)
  process.exit(2)
}

function changeFrom(view: AuthoringView): AuthoringChange | null {
  if (options.off) return { kind: "enable", entryId: entry(view, options.off).id, enabled: false }
  if (options.on) return { kind: "enable", entryId: entry(view, options.on).id, enabled: true }
  if (options.remove) return { kind: "remove", entryId: entry(view, options.remove).id }
  if (options.trust) return { kind: "trust", entryId: entry(view, options.trust).id }
  const draft = options.draft ? Draft.parse(JSON.parse(options.draft)) : null
  if (options.create && draft) return { kind: "create", sourceId: options.create, draft }
  if (options.edit && draft) return { kind: "edit", entryId: entry(view, options.edit).id, draft }
  return null
}

const view = await authoring.view(cwd, target)
const change = changeFrom(view)
if (!change) {
  if (options.json) console.log(JSON.stringify(view, null, 2))
  else {
    console.log(`${provider} ${view.family} in ${cwd}\n${view.precedence}\n${view.reload}`)
    for (const source of view.sources) {
      const notes = [source.exists ? "" : "absent", source.trust ? `trust ${source.trust.state}: ${source.trust.detail}` : "", source.writable.supported ? "" : `read-only: ${source.writable.reason}`, source.off ? `off by ${source.off.key}` : "", source.problem ? `! ${source.problem}` : ""].filter(Boolean)
      console.log(`\n${source.rank}. [${source.scope}] ${source.path}\n   id ${source.id}${notes.length ? `\n   ${notes.join("\n   ")}` : ""}`)
      for (const item of view.entries.filter((candidate) => candidate.sourceId === source.id))
        console.log(`   - ${item.name}${item.enabled ? "" : " (off)"}${item.trust ? ` [${item.trust.state}]` : ""}${item.shadowedBy ? " (shadowed)" : ""}\n     ${item.id}`)
    }
  }
} else {
  const plan = await authoring.preview(cwd, target, change)
  console.log(`${plan.summary}\n${plan.effect} · ${plan.scope} · revision ${plan.revision?.slice(0, 12) ?? "none (new file)"}\n`)
  console.log(unifiedDiff(plan.path, plan.lines))
  if (options.apply) {
    const applied = await authoring.apply(cwd, target, change, plan.revision)
    console.log(`\nApplied.${applied.backup ? ` The file as it was is at ${applied.backup}` : ""}`)
  } else console.log(`\nDry run: nothing was written. Add --apply to write it${plan.backup ? `, keeping the file as it was in ${join(authoringBackups(options["data-dir"] ?? defaultDataDir()))}` : ""}.`)
}
