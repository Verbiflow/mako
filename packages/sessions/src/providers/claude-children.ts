import { readdir, readFile, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { z } from "zod"
import { boundedChildren, MarkedLineScans, parsedJson, type ChildState, type ChildTranscript } from "../children.js"
import { readHead } from "../jsonl.js"
import type { ThreadRef } from "../format.js"

/**
 * Claude Code's subagents. Since 2.1 each runs in its own transcript beside
 * its session's: `<project>/<session-id>/subagents/agent-<agent-id>.jsonl`,
 * every line marked `isSidechain`, with `agent-<agent-id>.meta.json` naming
 * the `Agent` call that started it (`toolUseId`), its type and description,
 * and for a subagent's own subagent the agent that started it
 * (`parentAgentId`). Nested ones sit in the same folder.
 *
 * The session names each child in its `Agent` call's result
 * (`toolUseResult.agentId`, with `status` `completed` for one that answered
 * and `async_launched` for one sent to the background) and in the
 * `<task-notification>` Claude Code delivers when a background one settles.
 */

const MetaSchema = z.object({
  agentType: z.string().optional(),
  description: z.string().optional(),
  toolUseId: z.string().optional(),
  parentAgentId: z.string().optional(),
})
const META_BYTES = 64 * 1024
const AGENT_TOOLS = new Set(["Agent", "Task"])

/** The session a subagent transcript belongs to, when `path` is one under `roots`. */
export function claudeChildPath(path: string, roots: readonly string[]): { parentPath: string; sessionId: string; agentId: string } | null {
  const match = /^(.+)\/([^/]+)\/subagents\/agent-([^/]+)\.jsonl$/.exec(path)
  if (!match || !roots.some((root) => path.startsWith(`${root}/`))) return null
  const [, project, sessionId, agentId] = match
  if (!project || !sessionId || !agentId || dirname(project) === project) return null
  return { parentPath: join(project, `${sessionId}.jsonl`), sessionId, agentId }
}

/** What the session's own lines say about its agents. */
interface ParentLinks {
  /** `Agent` calls by tool use id. */
  calls: Map<string, { description?: string; role?: string }>
  /** Each answered call's agent and what its result said. */
  results: Map<string, { agentId: string; status?: string; model?: string }>
  /** Agents whose end a task notification reported, with the status it gave. */
  ended: Map<string, string>
}

const ToolUse = z.object({
  type: z.literal("tool_use"),
  id: z.string(),
  name: z.string(),
  input: z.object({ description: z.string().optional().catch(undefined), subagent_type: z.string().optional().catch(undefined) }).optional().catch(undefined),
})
const ToolResult = z.object({ type: z.literal("tool_result"), tool_use_id: z.string() })
const ParentLine = z.object({
  message: z.object({ content: z.array(z.unknown()).optional().catch(undefined) }).optional(),
  toolUseResult: z.unknown().optional(),
})
const SidechainLine = z.object({ cwd: z.string().optional(), timestamp: z.string().optional(), isSidechain: z.literal(true) })
const AgentResult = z.object({ agentId: z.string(), status: z.string().optional(), resolvedModel: z.string().optional() })
const NOTIFICATION = /<task-id>([^<]+)<\/task-id>[\s\S]*?<status>([^<]+)<\/status>/g

function foldParent(links: ParentLinks, raw: string): void {
  // Claude Code writes notifications into queue records, attachments and prompts alike.
  for (const [, taskId, status] of raw.matchAll(NOTIFICATION))
    if (taskId && status) links.ended.set(taskId.trim(), status.trim())
  const line = parsedJson(ParentLine, raw)
  for (const part of line?.message?.content ?? []) {
    const use = ToolUse.safeParse(part)
    if (use.success && AGENT_TOOLS.has(use.data.name)) {
      links.calls.set(use.data.id, { description: use.data.input?.description, role: use.data.input?.subagent_type })
      continue
    }
    const result = ToolResult.safeParse(part)
    if (!result.success || !links.calls.has(result.data.tool_use_id)) continue
    const agent = AgentResult.safeParse(line?.toolUseResult)
    if (agent.success)
      links.results.set(result.data.tool_use_id, { agentId: agent.data.agentId, status: agent.data.status, model: agent.data.resolvedModel })
  }
}

export class ClaudeChildren {
  private readonly scans = new MarkedLineScans<ParentLinks>(
    ['"name":"Agent"', '"name":"Task"', '"agentId"', "<task-id>"],
    () => ({ calls: new Map(), results: new Map(), ended: new Map() }),
    foldParent
  )

  async list(parentPath: string): Promise<ChildTranscript[] | null> {
    const links = await this.scans.read(parentPath)
    if (!links) return null
    const sessionId = basename(parentPath, ".jsonl")
    const folder = join(dirname(parentPath), sessionId, "subagents")
    const names = await readdir(folder).catch(() => new Array<string>())
    const byAgent = new Map<string, { toolId: string; status?: string; model?: string }>()
    for (const [toolId, result] of links.results) byAgent.set(result.agentId, { toolId, status: result.status, model: result.model })
    const children: ChildTranscript[] = []
    const located = new Set<string>()
    const transcripts = names.filter((name) => /^agent-.+\.jsonl$/.test(name))
    await Promise.all(transcripts.map(async (name) => {
      const agentId = name.slice("agent-".length, -".jsonl".length)
      const path = join(folder, name)
      const [info, meta] = await Promise.all([stat(path).catch(() => null), readMeta(join(folder, `agent-${agentId}.meta.json`))])
      if (!info?.isFile()) return
      located.add(agentId)
      const result = byAgent.get(agentId)
      const toolId = meta?.toolUseId ?? result?.toolId
      const call = toolId ? links.calls.get(toolId) : undefined
      const child: ChildTranscript = {
        nativeId: agentId,
        path,
        state: claudeChildState(result?.status, links.ended.get(agentId)),
        startedAt: new Date(info.birthtimeMs || info.mtimeMs).toISOString(),
        updatedAt: new Date(info.mtimeMs).toISOString(),
      }
      if (toolId) child.toolId = toolId
      if (meta?.parentAgentId) child.spawnedBy = meta.parentAgentId
      const title = meta?.description ?? call?.description
      if (title) child.title = title
      const role = meta?.agentType ?? call?.role
      if (role) child.role = role
      if (result?.model) child.model = result.model
      children.push(child)
    }))
    // Named by the session, kept nowhere: the result says which agent ran.
    for (const [toolId, result] of links.results) {
      if (located.has(result.agentId)) continue
      const call = links.calls.get(toolId)
      const child: ChildTranscript = {
        nativeId: result.agentId,
        toolId,
        state: { kind: "missing", reason: "Claude Code kept no transcript for this agent beside the session." },
      }
      if (call?.description) child.title = call.description
      if (call?.role) child.role = call.role
      children.push(child)
    }
    return boundedChildren(children.sort((left, right) => (left.startedAt ?? "~").localeCompare(right.startedAt ?? "~"))).children
  }

  /** A subagent transcript's ref, from its first lines and its sidecar. */
  async ref(path: string, link: { parentPath: string; sessionId: string; agentId: string }): Promise<ThreadRef | null> {
    const info = await stat(path).catch(() => null)
    if (!info?.isFile()) return null
    const [head, meta] = await Promise.all([readHead(path, 65_536), readMeta(path.replace(/\.jsonl$/, ".meta.json"))])
    const ref: ThreadRef = {
      harness: "claude",
      nativeId: link.agentId,
      path,
      bytes: info.size,
      updatedAt: new Date(info.mtimeMs).toISOString(),
      childOf: { nativeId: link.sessionId, path: link.parentPath },
    }
    if (meta?.toolUseId) ref.childOf = { ...ref.childOf!, toolId: meta.toolUseId }
    if (meta?.description) ref.title = meta.description
    for (const raw of head.split("\n")) {
      const line = parsedJson(SidechainLine, raw)
      if (!line) continue
      ref.cwd ??= line.cwd
      ref.startedAt ??= line.timestamp
      if (ref.cwd && ref.startedAt) break
    }
    return ref
  }
}

/** Ended is the result for a foreground agent, and the notification for one sent to the background. */
function claudeChildState(status: string | undefined, notified: string | undefined): ChildState {
  if (notified || (status && status !== "async_launched")) return { kind: "complete" }
  return { kind: "partial", reason: "Claude Code hasn't recorded this agent's end: it is still running, or stopped without reporting." }
}

async function readMeta(path: string): Promise<z.infer<typeof MetaSchema> | null> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile() || info.size > META_BYTES) return null
  return parsedJson(MetaSchema, await readFile(path, "utf8").catch(() => "")) ?? null
}
