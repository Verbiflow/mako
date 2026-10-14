import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { z } from "zod"
import {
  AuthoringScopeSchema,
  NativeAuthoringFamilySchema,
  type AuthoringApplied,
  type AuthoringCatalog,
  type AuthoringChange,
  type AuthoringEntry,
  type AuthoringOperations,
  type AuthoringPlan,
  type AuthoringSource,
  type AuthoringTarget,
  type AuthoringView,
  type NativeAuthoringFamily,
} from "../contracts/native-authoring.js"
import type { AuthoringContext, AuthoringEdit, ProviderAuthoringCapability, ReadSource } from "./editing-capability.js"
import type { ToolHarnesses } from "./harnesses.js"
import { boundedRead, listFiles, revisionOf, type AuthoringFiles } from "./authoring-files.js"
import { diffLines, redactJson, redactToml } from "./authoring-text.js"

/**
 * Each harness's own hooks, commands and MCP servers, read from every file
 * it reads them from and changed in the one file a change belongs to. A
 * change is previewed first (the diff of that file, credentials redacted)
 * and applied only while the file is still what the preview read. Nothing
 * here runs a hook, a command or a server.
 */

const Target = z.object({ provider: z.string().min(1), family: NativeAuthoringFamilySchema, cwd: z.string().min(1) })
const Draft = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("hook"), event: z.string().min(1).max(80), matcher: z.string().max(1000).optional(), type: z.string().min(1).max(40), run: z.string().max(16 * 1024), timeout: z.number().positive().max(86_400).optional() }),
  z.object({ kind: z.literal("command"), invocation: z.string().min(1).max(200), text: z.string().max(256 * 1024) }),
  z.object({ kind: z.literal("module"), name: z.string().min(1).max(120), text: z.string().max(256 * 1024) }),
])
const Change = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("create"), sourceId: z.string().min(1), draft: Draft }),
  z.object({ kind: z.literal("edit"), entryId: z.string().min(1), draft: Draft }),
  z.object({ kind: z.literal("enable"), entryId: z.string().min(1), enabled: z.boolean() }),
  z.object({ kind: z.literal("remove"), entryId: z.string().min(1) }),
  z.object({ kind: z.literal("trust"), entryId: z.string().min(1) }),
])
const Revision = z.string().regex(/^[a-f0-9]{64}$/).nullable()

const NONE: AuthoringOperations = {
  create: { supported: false, reason: "Unavailable" },
  edit: { supported: false, reason: "Unavailable" },
  disable: { supported: false, reason: "Unavailable" },
  remove: { supported: false, reason: "Unavailable" },
  trust: { supported: false, reason: "Unavailable" },
}

/** The definition family a view's absence is declared under. */
const DEFINITION_FAMILY = { hooks: "hooks", commands: "commands", mcp: "mcpEditing" } as const satisfies Record<NativeAuthoringFamily, string>
const FORM = { hooks: "hook", commands: "command", mcp: "mcp" } as const satisfies Record<NativeAuthoringFamily, AuthoringView["form"]>

/** A target checked against the project in front, with the harness's capability for it. */
interface Resolved {
  target: AuthoringTarget
  capability: ProviderAuthoringCapability
}

/** The one file a change writes, computed from what the sources hold now. */
interface Planned {
  target: AuthoringTarget
  edit: AuthoringEdit
}

/** Each harness's hooks, commands and MCP servers as people manage them in Settings. */
export interface NativeAuthoring {
  catalog(cwd: string): Promise<AuthoringCatalog>
  view(cwd: string, target: AuthoringTarget): Promise<AuthoringView>
  preview(cwd: string, target: AuthoringTarget, change: AuthoringChange): Promise<AuthoringPlan>
  /** Writes what `preview` showed, if the file is still at `revision`. */
  apply(cwd: string, target: AuthoringTarget, change: AuthoringChange, revision: string | null): Promise<AuthoringApplied>
}

/** Everything a source holds, read without following it anywhere it can't be written back. */
export async function readSources(capability: ProviderAuthoringCapability, context: AuthoringContext): Promise<ReadSource[]> {
  const specs = await capability.sources(context)
  return Promise.all(specs.map(async (spec): Promise<ReadSource> => {
    try {
      if (spec.format !== "folder") return { spec, text: await boundedRead(spec.path), files: [] }
      const names = await listFiles(spec.path, spec.entries?.endings ?? [".md"], spec.entries?.depth ?? 0)
      const files = await Promise.all(names.map(async (path) => ({ path, text: await boundedRead(join(spec.path, path)) ?? "" })))
      return { spec, text: null, files }
    } catch (error) {
      return { spec, text: null, files: [], problem: error instanceof Error ? error.message : `${spec.path} couldn't be read.` }
    }
  }))
}

/** Which entries the harness passes over for another of the same name. */
export function markShadowed(entries: AuthoringEntry[], sources: readonly ReadSource[], names: ProviderAuthoringCapability["names"]): AuthoringEntry[] {
  if (names === "all") return entries
  const rank = new Map(sources.map((source) => [source.spec.id, source.spec.rank]))
  const winners = new Map<string, AuthoringEntry>()
  for (const entry of entries) {
    const current = winners.get(entry.name)
    const mine = rank.get(entry.sourceId) ?? 0
    const theirs = current ? rank.get(current.sourceId) ?? 0 : null
    if (theirs === null || (names === "first" ? mine < theirs : mine > theirs)) winners.set(entry.name, entry)
  }
  return entries.map((entry) => {
    const winner = winners.get(entry.name)
    return winner && winner.id !== entry.id ? { ...entry, shadowedBy: winner.id } : entry
  })
}

/** One family of one harness as Mako reads it now. */
export function authoringView(capability: ProviderAuthoringCapability, label: string, sources: readonly ReadSource[]): AuthoringView {
  const reading = capability.read(sources)
  const problems = new Map(reading.problems.map((problem) => [problem.sourceId, problem.problem]))
  const off = new Map(reading.off.map((entry) => [entry.sourceId, entry]))
  const view: AuthoringView = {
    provider: capability.provider,
    family: capability.family,
    label,
    form: capability.form,
    operations: capability.operations,
    precedence: capability.precedence,
    reload: capability.reload,
    sources: sources.map(({ spec, text, files, problem }) => {
      const source: AuthoringSource = { id: spec.id, scope: AuthoringScopeSchema.parse(spec.scope), path: spec.path, label: spec.label, rank: spec.rank, exists: text !== null || files.length > 0, writable: spec.writable }
      if (spec.trust) source.trust = spec.trust
      if (spec.switches) source.switches = true
      const switched = off.get(spec.id)
      if (switched) source.off = { key: switched.key, detail: switched.detail }
      const failure = problem ?? problems.get(spec.id)
      if (failure) source.problem = failure
      return source
    }).sort((left, right) => left.rank - right.rank),
    entries: markShadowed(reading.entries, sources, capability.names),
  }
  if (capability.hooks) view.hooks = capability.hooks
  return view
}

const redact = (format: AuthoringEdit["format"], text: string) => format === "json" ? redactJson(text) : format === "toml" ? redactToml(text) : text

export function planOf(target: AuthoringTarget, change: AuthoringChange, edit: AuthoringEdit): AuthoringPlan {
  return {
    target,
    change,
    path: edit.path,
    scope: edit.scope,
    summary: edit.summary,
    revision: revisionOf(edit.before),
    effect: edit.before === edit.after ? "unchanged" : edit.before === null ? "create-file" : edit.after === null ? "delete-file" : "edit-file",
    lines: diffLines(redact(edit.format, edit.before ?? ""), redact(edit.format, edit.after ?? "")),
    backup: edit.before !== null && edit.before !== edit.after,
  }
}

export function nativeAuthoring(harnesses: ToolHarnesses, files: AuthoringFiles): NativeAuthoring {
  async function context(provider: string, cwd: string): Promise<AuthoringContext> {
    const { env, account } = await harnesses.account(provider)
    const result: AuthoringContext = { cwd, home: env.HOME || homedir(), env }
    if (account.dir) result.accountDir = account.dir
    return result
  }

  function capability(cwd: string, input: AuthoringTarget): Resolved {
    const target = Target.parse(input)
    if (resolve(target.cwd) !== resolve(cwd)) throw new Error("The project changed after this opened. Reopen it in the project you meant.")
    const found = harnesses.authoring[target.family].get(target.provider)
    if (!found) {
      const reason = harnesses.harnesses.get(target.provider)?.absent[DEFINITION_FAMILY[target.family]]?.reason
      throw new Error(reason ?? "Mako can't edit this for this agent.")
    }
    return { target, capability: found }
  }

  async function view(cwd: string, input: AuthoringTarget, known?: AuthoringContext): Promise<AuthoringView> {
    const { target, capability: found } = capability(cwd, input)
    return authoringView(found, harnesses.label(target.provider), await readSources(found, known ?? await context(target.provider, cwd)))
  }

  async function edit(cwd: string, input: AuthoringTarget, change: AuthoringChange): Promise<Planned> {
    const { target, capability: found } = capability(cwd, input)
    const parsed = Change.parse(change)
    const operation = parsed.kind === "enable" ? "disable" : parsed.kind
    const support = found.operations[operation]
    if (!support.supported) throw new Error(support.reason)
    return { target, edit: found.change(await readSources(found, await context(target.provider, cwd)), parsed) }
  }

  return {
    async catalog(cwd) {
      // One account lookup per harness, shared by its three families.
      const contexts = new Map(harnesses.harnesses.list().map((harness) => [harness.provider, context(harness.provider, cwd)]))
      const views = await Promise.all(harnesses.harnesses.list().flatMap((harness) => NativeAuthoringFamilySchema.options.map(async (family) => {
        const found = harnesses.authoring[family].get(harness.provider)
        if (found) return view(cwd, { provider: harness.provider, family, cwd }, await contexts.get(harness.provider))
        const absent = harness.absent[DEFINITION_FAMILY[family]]
        const empty: AuthoringView = {
          provider: harness.provider, family, label: harnesses.label(harness.provider), form: FORM[family], operations: NONE,
          precedence: "", reload: "", sources: [], entries: [],
          absent: { by: absent?.absent ?? "mako", reason: absent?.reason ?? "Unavailable" },
        }
        return empty
      })))
      return { cwd, views }
    },
    view,
    async preview(cwd, input, change) {
      const { target, edit: result } = await edit(cwd, input, change)
      return planOf(target, change, result)
    },
    async apply(cwd, input, change, revision) {
      const expected = Revision.parse(revision)
      const { target, edit: result } = await edit(cwd, input, change)
      const plan = planOf(target, change, result)
      if (plan.revision !== expected) throw new Error(`${result.path} changed after the preview. Preview the change again.`)
      if (plan.effect === "unchanged") return { plan, backup: null, view: await view(cwd, target) }
      const written = await files.write(result.root, result.path, expected, result.after, null)
      return { plan, backup: written.backup, view: await view(cwd, target) }
    },
  }
}
