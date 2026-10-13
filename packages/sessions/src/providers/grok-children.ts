import { existsSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { boundedChildren, MarkedLineScans, parsedJson, type ChildState, type ChildTranscript } from "../children.js"
import { parseLine } from "../jsonl.js"
import { filesUnder } from "../harness-records.js"
import type { ThreadRef } from "../format.js"

/**
 * Grok's subagents. Each runs as a session of its own in the sessions tree,
 * under the folder of the directory it ran in (`child_cwd`), its summary
 * marked `session_kind: subagent`. The parent keeps one folder per child,
 * `subagents/<child-id>/meta.json`, with the child's id, its attempt, its
 * description, type and model, and its status (`running`, `completed`,
 * `failed`, `cancelled`, `stopped`); Grok before `meta.json` wrote
 * `subagents/<child-id>.json`. The parent's updates say the same as
 * `subagent_spawned` and `subagent_finished`, and the `spawn_subagent`
 * call's result names the child (`rawOutput.subagent_id`).
 */

const Meta = z.object({
  child_session_id: z.string().optional(),
  subagent_id: z.string().optional(),
  parent_session_id: z.string().optional(),
  status: z.string().optional(),
  description: z.string().optional(),
  subagent_type: z.string().nullish(),
  effective_model_id: z.string().nullish(),
  started_at: z.string().optional(),
  completed_at: z.string().nullish(),
  child_cwd: z.string().optional(),
})
type Meta = z.infer<typeof Meta>
const META_BYTES = 512 * 1024
const ENDED = new Set(["completed", "failed", "cancelled", "stopped"])
const TRANSCRIPTS = ["updates.jsonl", "chat_history.jsonl"]

const Named = { child_session_id: z.string().optional(), subagent_id: z.string().optional() }
const Update = z.object({
  params: z.object({
    update: z.union([
      z.object({ sessionUpdate: z.literal("subagent_spawned"), ...Named, description: z.string().optional(), subagent_type: z.string().nullish(), model: z.string().nullish() }),
      z.object({ sessionUpdate: z.literal("subagent_finished"), ...Named, status: z.string().optional() }),
      z.object({
        sessionUpdate: z.enum(["tool_call", "tool_call_update"]),
        toolCallId: z.string(),
        rawOutput: z.object({ subagent_id: z.string() }).nullish().catch(undefined),
        rawInput: z.object({ resume_from: z.string() }).nullish().catch(undefined),
      }),
    ]),
  }),
})

/** What the parent's updates say about its subagents. */
interface ParentLinks {
  spawned: Map<string, { description?: string; role?: string; model?: string }>
  finished: Map<string, string>
  /** The `spawn_subagent` call that started or resumed each child. */
  calls: Map<string, string>
}

function foldUpdate(links: ParentLinks, raw: string): void {
  const update = parsedJson(Update, raw)?.params.update
  if (!update) return
  if (update.sessionUpdate === "subagent_spawned") {
    const child = update.child_session_id ?? update.subagent_id
    if (child) links.spawned.set(child, { description: update.description, role: update.subagent_type ?? undefined, model: update.model ?? undefined })
  } else if (update.sessionUpdate === "subagent_finished") {
    const child = update.child_session_id ?? update.subagent_id
    if (child) links.finished.set(child, update.status ?? "completed")
  } else {
    const named = update.rawOutput?.subagent_id ?? update.rawInput?.resume_from
    if (named && !links.calls.has(named)) links.calls.set(named, update.toolCallId)
  }
}

export class GrokChildren {
  private readonly scans = new MarkedLineScans<ParentLinks>(
    ['"subagent_spawned"', '"subagent_finished"', '"subagent_id"', '"resume_from"'],
    () => ({ spawned: new Map(), finished: new Map(), calls: new Map() }),
    foldUpdate
  )
  private readonly root: string
  /** Each child's parent folder, once found. */
  private readonly parents = new Map<string, string>()

  constructor(root: string) {
    this.root = root
  }

  async list(parentPath: string): Promise<ChildTranscript[] | null> {
    const session = dirname(parentPath)
    if (dirname(dirname(session)) !== this.root) return null
    const links = await this.scans.read(parentPath)
    if (!links) return null
    const metas = await this.metas(session)
    const ids = new Set([...metas.keys(), ...links.spawned.keys()])
    const children = await Promise.all([...ids].map(async (id): Promise<ChildTranscript> => {
      const meta = metas.get(id)
      const spawned = links.spawned.get(id)
      const path = await this.transcriptOf(id, meta?.child_cwd)
      const status = links.finished.get(id) ?? meta?.status
      const child: ChildTranscript = { nativeId: id, state: path ? grokChildState(status) : { kind: "missing", reason: "Grok keeps no session for this subagent." } }
      if (path) {
        child.path = path
        const info = await stat(path).catch(() => null)
        if (info) child.updatedAt = new Date(info.mtimeMs).toISOString()
      }
      const toolId = links.calls.get(id)
      if (toolId) child.toolId = toolId
      const title = meta?.description ?? spawned?.description
      if (title) child.title = title
      const role = meta?.subagent_type ?? spawned?.role
      if (role) child.role = role
      const model = meta?.effective_model_id ?? spawned?.model
      if (model) child.model = model
      if (meta?.started_at) child.startedAt = meta.started_at
      return child
    }))
    return boundedChildren(children.sort((left, right) => (left.startedAt ?? "~").localeCompare(right.startedAt ?? "~"))).children
  }

  /** Every file of the parent's subagents' sessions, for its records. */
  async recordsOf(parentPath: string): Promise<string[]> {
    const metas = await this.metas(dirname(parentPath))
    const files: string[] = []
    for (const [id, meta] of metas) {
      const transcript = await this.transcriptOf(id, meta.child_cwd)
      if (transcript) files.push(...(await filesUnder(dirname(transcript))))
    }
    return files
  }

  /** A subagent's session as a child's ref; null for any other session. */
  async ref(path: string, bytes: number, mtimeMs: number): Promise<ThreadRef | null> {
    const summary = z.object({
      info: z.object({ id: z.string(), cwd: z.string().optional() }),
      session_kind: z.string().optional(),
      current_model_id: z.string().optional(),
      created_at: z.string().optional(),
    }).safeParse(parseLine(await readFile(join(dirname(path), "summary.json"), "utf8").catch(() => "")))
    if (!summary.success) return null
    const { info } = summary.data
    if (!summary.data.session_kind?.startsWith("subagent")) return null
    // A child's summary doesn't name its parent; the parent's `subagents/` does.
    const parentDir = await this.parentOf(info.id)
    if (!parentDir) return null
    const parent = basename(parentDir)
    const meta = (await this.metas(parentDir)).get(info.id)
    const ref: ThreadRef = {
      harness: "grok",
      nativeId: info.id,
      path,
      bytes,
      updatedAt: new Date(mtimeMs).toISOString(),
      childOf: { nativeId: parent },
    }
    const parentTranscript = transcriptIn(parentDir)
    if (parentTranscript) ref.childOf = { nativeId: parent, path: parentTranscript }
    if (info.cwd) ref.cwd = info.cwd
    if (summary.data.created_at) ref.startedAt = summary.data.created_at
    if (summary.data.current_model_id) ref.model = summary.data.current_model_id
    if (meta?.description) ref.title = meta.description
    return ref
  }

  /** The parent's `subagents/` records by child id, both shapes. */
  private async metas(session: string): Promise<Map<string, Meta>> {
    const folder = join(session, "subagents")
    const found = new Map<string, Meta>()
    const entries = await readdir(folder, { withFileTypes: true }).catch(() => [])
    await Promise.all(entries.map(async (entry) => {
      const file = entry.isDirectory() ? join(folder, entry.name, "meta.json") : entry.name.endsWith(".json") ? join(folder, entry.name) : undefined
      if (!file) return
      const info = await stat(file).catch(() => null)
      if (!info?.isFile() || info.size > META_BYTES) return
      const meta = Meta.safeParse(parseLine(await readFile(file, "utf8").catch(() => "")))
      const id = meta.data?.child_session_id ?? meta.data?.subagent_id ?? basename(entry.name, ".json")
      if (meta.success) found.set(id, meta.data)
    }))
    return found
  }

  /** A child's transcript: under the folder of the directory it ran in, else wherever Grok put it. */
  private async transcriptOf(id: string, cwd: string | undefined): Promise<string | undefined> {
    if (cwd) {
      const transcript = transcriptIn(join(this.root, grokFolderName(cwd), id))
      if (transcript) return transcript
    }
    for (const folder of await this.sessionFolders(id)) {
      const transcript = transcriptIn(folder)
      if (transcript) return transcript
    }
    return undefined
  }

  /** The session folder whose `subagents/` lists `id`. */
  private async parentOf(id: string): Promise<string | undefined> {
    const held = this.parents.get(id)
    if (held && existsSync(join(held, "subagents"))) return held
    for (const workspace of await readdir(this.root).catch(() => new Array<string>()))
      for (const session of await readdir(join(this.root, workspace)).catch(() => new Array<string>())) {
        const folder = join(this.root, workspace, session)
        if (!existsSync(join(folder, "subagents", id)) && !existsSync(join(folder, "subagents", `${id}.json`))) continue
        this.parents.set(id, folder)
        if (this.parents.size > 1024) this.parents.delete(this.parents.keys().next().value!)
        return folder
      }
    return undefined
  }

  private async sessionFolders(id: string): Promise<Set<string>> {
    const folders = new Set<string>()
    for (const workspace of await readdir(this.root).catch(() => new Array<string>())) {
      const folder = join(this.root, workspace, id)
      if (existsSync(folder)) folders.add(folder)
    }
    return folders
  }
}

/** The folder Grok names a working directory by: its URL encoding, with `!'()*` escaped too. */
export function grokFolderName(cwd: string): string {
  return encodeURIComponent(cwd).replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)
}

function transcriptIn(folder: string): string | undefined {
  return TRANSCRIPTS.map((name) => join(folder, name)).find((path) => existsSync(path))
}

function grokChildState(status: string | undefined): ChildState {
  if (status && ENDED.has(status)) return { kind: "complete" }
  return { kind: "partial", reason: status === "running" ? "Grok says this subagent is still running." : "Grok hasn't recorded this subagent's end." }
}
