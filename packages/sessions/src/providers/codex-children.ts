import { stat } from "node:fs/promises"
import { z } from "zod"
import { boundedChildren, MarkedLineScans, type ChildTranscript } from "../children.js"
import { namedRollout, rolloutThread, type CodexRollouts } from "./codex-rollouts.js"
import type { ThreadRef } from "../format.js"
import type { NativeStores } from "../read-only-sqlite.js"
import { READ_BUSY_TIMEOUT_MS, SqliteBusy } from "./sqlite-busy.js"
import { SessionUnreadable } from "./types.js"

/**
 * Codex's spawned agents. Each is a thread of its own with its own rollout
 * (`session_meta.source.subagent.thread_spawn.parent_thread_id` names the
 * thread that spawned it), recorded in the state database's
 * `thread_spawn_edges` (`open` until the agent is closed) and in the
 * parent's rollout as `SubAgentActivity` items: `started` under the id of the
 * call that spawned it, then `interacted`, `completed` or `interrupted`.
 * Multi-agent v1 records `CollabAgentToolCall` items instead, naming the
 * spawned threads in `receiver_thread_ids` and their states in
 * `agents_states`. A thread's own agents can spawn agents, one level per
 * edge.
 *
 * A fork copies its parent's rollout, `SubAgentActivity` items included, so
 * an item names this thread's own agent only where the edge or the child's
 * meta says this thread spawned it.
 *
 * A review (`review/start`, `codex review`) runs as a thread of its own too,
 * `thread_source` `subagent` with `source: {"subagent": "review"}`, which no
 * spawn edge names: its meta's `parent_thread_id` names the thread it
 * reviewed. The parent's rollout copies the reviewer's items between its
 * `EnteredReviewMode` and `ExitedReviewMode`, whose id the review's row
 * takes; reviews run one at a time, so the n-th review thread is the n-th
 * review the parent ended.
 */

/** How deep spawned agents of spawned agents are followed. */
const MAX_DEPTH = 4

const Activity = z.object({
  type: z.literal("SubAgentActivity"),
  id: z.string(),
  kind: z.string(),
  agent_thread_id: z.string(),
  agent_path: z.string().optional(),
})
const Collab = z.object({
  type: z.literal("CollabAgentToolCall"),
  id: z.string(),
  tool: z.string(),
  receiver_thread_ids: z.array(z.string()).optional(),
  agents_states: z.record(z.string(), z.object({ status: z.string() }).nullish()).optional(),
})
const ItemLine = z.object({ payload: z.object({ item: z.unknown().optional() }) })
const Spawn = z.object({
  subagent: z.object({ thread_spawn: z.object({ parent_thread_id: z.string(), agent_path: z.string().nullish(), agent_nickname: z.string().nullish(), agent_role: z.string().nullish() }) }),
})
/** A thread another started that no spawn edge names (a review; a `guardian` approval reviewer is `{"other": "guardian"}`), by its meta's `parent_thread_id`. */
const Started = z.object({ subagent: z.union([z.string(), z.object({ other: z.string() }).transform((value) => value.other)]) })
  .transform(({ subagent }) => ({ role: subagent, title: subagent === "review" ? "Code review" : subagent }))
const ReviewEnd = z.object({ type: z.literal("ExitedReviewMode"), id: z.string() })
const ReviewEndEvent = z.object({ payload: z.object({ type: z.literal("exited_review_mode"), item_id: z.string().optional() }) })
const TableRow = z.object({ name: z.string() })
/** Empty text in the state database is no value. */
const Text = z.string().nullable().transform((value) => value || undefined)
const Stamp = z.number().nullable().transform((value) => (value && value > 0 ? new Date(value).toISOString() : undefined))
const ReviewRow = z.object({ id: z.string().min(1), rollout: Text, created: Stamp })
const EdgeRow = z.object({
  child: z.string().min(1),
  status: z.string().nullable(),
  rollout: Text,
  title: Text,
  nickname: Text,
  role: Text,
  path: Text,
  model: Text,
  created: Stamp,
  updated: Stamp,
})
const ENDED = new Set(["completed", "interrupted", "errored", "shutdown"])
const SPAWNS = new Set(["spawn_agent", "spawnAgent", "resume_agent", "resumeAgent"])

/** What a rollout's own lines say about the agents it named. */
interface RolloutLinks {
  /** Each agent by the call that started it. */
  started: Map<string, { toolId: string; path?: string }>
  /** The latest word on each agent: running again, or ended. */
  ended: Map<string, boolean>
  /** Each review it ended, in order: by its `ExitedReviewMode` item's id, and by its `exited_review_mode` event's where only those are written. */
  reviews: { items: string[]; events: string[] }
}

function foldRollout(links: RolloutLinks, raw: string): void {
  let item: unknown
  try {
    const parsed: unknown = JSON.parse(raw)
    const event = ReviewEndEvent.safeParse(parsed)
    if (event.success) {
      links.reviews.events.push(event.data.payload.item_id ?? "")
      return
    }
    const line = ItemLine.safeParse(parsed)
    if (!line.success) return
    item = line.data.payload.item
  } catch {
    return
  }
  const review = ReviewEnd.safeParse(item)
  if (review.success) {
    links.reviews.items.push(review.data.id)
    return
  }
  const activity = Activity.safeParse(item)
  if (activity.success) {
    const { id, kind, agent_thread_id: agent, agent_path: path } = activity.data
    if (kind === "started" && !links.started.has(agent)) links.started.set(agent, { toolId: id, path })
    links.ended.set(agent, kind === "completed" || kind === "interrupted")
    return
  }
  const collab = Collab.safeParse(item)
  if (!collab.success) return
  if (SPAWNS.has(collab.data.tool))
    for (const agent of collab.data.receiver_thread_ids ?? []) if (!links.started.has(agent)) links.started.set(agent, { toolId: collab.data.id })
  for (const [agent, state] of Object.entries(collab.data.agents_states ?? {}))
    if (state) links.ended.set(agent, ENDED.has(state.status))
}

interface Edge {
  child: string
  parent: string
  closed: boolean
  rolloutPath?: string
  title?: string
  nickname?: string
  role?: string
  path?: string
  model?: string
  createdAt?: string
  updatedAt?: string
}

export class CodexChildren {
  private readonly scans = new MarkedLineScans<RolloutLinks>(
    ['"SubAgentActivity"', '"CollabAgentToolCall"', '"ExitedReviewMode"', '"exited_review_mode"'],
    () => ({ started: new Map(), ended: new Map(), reviews: { items: [], events: [] } }),
    foldRollout
  )
  /** The thread each review rollout names in its meta, by path: a rollout's first line never changes. */
  private readonly reviewed = new Map<string, { parent: string; role: string; title: string } | null>()
  private readonly source: { stores: NativeStores; rollouts: CodexRollouts; metadataPath: string }

  constructor(source: { stores: NativeStores; rollouts: CodexRollouts; metadataPath: string }) {
    this.source = source
  }

  async list(parentPath: string): Promise<ChildTranscript[] | null> {
    const parentId = rolloutThread(parentPath)
    if (!parentId) return null
    const edges = this.edges(parentId)
    const rollouts = await this.source.rollouts.list()
    const reviews = await this.reviews(parentId, rollouts)
    // A thread the state database knows and lists no agent or review under started none: its rollout isn't read.
    if (!edges.length && !reviews.length && this.knows(parentId)) return (await stat(parentPath).catch(() => null))?.isFile() ? [] : null
    const [links, head] = await Promise.all([this.scans.read(parentPath), this.source.rollouts.meta(parentPath)])
    if (!links) return null
    const known = new Set(edges.map((edge) => edge.child))
    // A started item no edge explains is this thread's own unless it was copied by a fork.
    if (!head?.forked_from_id)
      for (const agent of links.started.keys()) if (!known.has(agent)) edges.push({ child: agent, parent: parentId, closed: false })
    const ended = links.reviews.items.length ? links.reviews.items : links.reviews.events
    let reviewIndex = 0
    const reviewed = reviews.filter((review) => !known.has(review.id)).map((review): ChildTranscript => {
      // Only a review ends in the parent's rollout; another started thread's end isn't recorded there.
      const toolId = review.role === "review" ? ended[reviewIndex++] : undefined
      const child: ChildTranscript = {
        nativeId: review.id,
        path: review.path,
        title: review.title,
        role: review.role,
        state: toolId !== undefined ? { kind: "complete" } : { kind: "partial", reason: "Codex hasn't recorded this thread's end: it is still running, or stopped without reporting." },
      }
      if (toolId) child.toolId = toolId
      if (review.startedAt) child.startedAt = review.startedAt
      return child
    })
    const children = await Promise.all(edges.map(async (edge): Promise<ChildTranscript> => {
      const direct = edge.parent === parentId
      const started = direct ? links.started.get(edge.child) : undefined
      const path = await currentRollout(rollouts, edge.child, edge.rolloutPath)
      const child: ChildTranscript = {
        nativeId: edge.child,
        state: path
          ? edge.closed || links.ended.get(edge.child) === true
            ? { kind: "complete" }
            : { kind: "partial", reason: "Codex hasn't recorded this agent's end: it is still running, or stopped without reporting." }
          : { kind: "missing", reason: edge.rolloutPath || edge.title ? "Codex no longer keeps this thread's rollout; its state database still lists the thread." : "Codex keeps no rollout or record of this thread." },
      }
      if (path) child.path = path
      if (started) child.toolId = started.toolId
      if (!direct) child.spawnedBy = edge.parent
      const title = edge.title ?? edge.nickname ?? started?.path ?? edge.path
      if (title) child.title = title
      if (edge.role) child.role = edge.role
      if (edge.model) child.model = edge.model
      if (edge.createdAt) child.startedAt = edge.createdAt
      if (edge.updatedAt) child.updatedAt = edge.updatedAt
      return child
    }))
    children.push(...reviewed)
    return boundedChildren(children.sort((left, right) => (left.startedAt ?? "~").localeCompare(right.startedAt ?? "~"))).children
  }

  /**
   * The rollouts of the thread's agents and reviews, and their agents', for
   * its records: every file of each, and the one each is read at.
   */
  async rolloutsOf(parentPath: string): Promise<{ ids: string[]; files: string[]; children: string[] }> {
    const parentId = rolloutThread(parentPath)
    if (!parentId) return { ids: [], files: [], children: [] }
    const rollouts = await this.source.rollouts.list()
    const edges = this.edges(parentId)
    const reviews = (await this.reviews(parentId, rollouts)).filter((review) => !edges.some((edge) => edge.child === review.id))
    const ids = [...edges.map((edge) => edge.child), ...reviews.map((review) => review.id)]
    const files = await this.source.rollouts.filesOfThreads(ids)
    const read = await Promise.all(edges.map((edge) => currentRollout(rollouts, edge.child, edge.rolloutPath)))
    const children = [...read, ...reviews.map((review) => review.path)].filter((path) => path !== undefined)
    return { ids, files, children }
  }

  /**
   * The reviews of `parentId` Codex keeps a rollout of, oldest first: the
   * state database's started threads no spawn edge names, by what their
   * meta says they reviewed. Each meta is read once.
   */
  private async reviews(parentId: string, rollouts: readonly string[]): Promise<{ id: string; path: string; role: string; title: string; startedAt?: string }[]> {
    let rows: z.infer<typeof ReviewRow>[]
    let database
    try {
      database = this.source.stores.open(this.source.metadataPath, { timeout: READ_BUSY_TIMEOUT_MS })
    } catch {
      return []
    }
    try {
      const columns = new Set(database.prepare("SELECT name FROM pragma_table_info('threads')").all().flatMap((row) => TableRow.safeParse(row).data?.name ?? []))
      if (!columns.has("thread_source") || !columns.has("source")) return []
      rows = database.prepare("SELECT id, rollout_path AS rollout, created_at_ms AS created FROM threads WHERE thread_source = 'subagent' AND instr(source, '\"thread_spawn\"') = 0").all().flatMap((row) => ReviewRow.safeParse(row).data ?? [])
    } catch (error) {
      if (SqliteBusy.safeParse(error).success) throw new SessionUnreadable(this.source.metadataPath, { cause: error })
      throw error
    } finally {
      database.close()
    }
    const found: { id: string; path: string; role: string; title: string; startedAt?: string }[] = []
    for (const row of rows) {
      const path = await currentRollout(rollouts, row.id, row.rollout)
      if (!path) continue
      let started = this.reviewed.get(path)
      if (started === undefined) {
        const meta = await this.source.rollouts.meta(path)
        const as = meta && !Spawn.safeParse(meta.source).success ? Started.safeParse(meta.source).data ?? null : null
        started = as && meta?.parent_thread_id ? { parent: meta.parent_thread_id.toLowerCase(), ...as } : null
        this.reviewed.set(path, started)
      }
      if (started?.parent === parentId) found.push({ id: row.id, path, role: started.role, title: started.title, ...row.created && { startedAt: row.created } })
    }
    return found.sort((left, right) => (left.startedAt ?? "~").localeCompare(right.startedAt ?? "~"))
  }

  /** A spawned agent's or a review's rollout as a child's ref; null for any other rollout. */
  async ref(path: string, bytes: number, mtimeMs: number): Promise<ThreadRef | null> {
    const meta = await this.source.rollouts.meta(path)
    const spawn = Spawn.safeParse(meta?.source)
    const started = meta && !spawn.success ? Started.safeParse(meta.source).data : undefined
    if (meta && started && meta.parent_thread_id) {
      const ref: ThreadRef = { harness: "codex", nativeId: meta.id, path, bytes, title: started.title, updatedAt: new Date(mtimeMs).toISOString(), childOf: { nativeId: meta.parent_thread_id } }
      if (meta.cwd) ref.cwd = meta.cwd
      if (meta.timestamp) ref.startedAt = meta.timestamp
      return ref
    }
    if (!meta || !spawn.success) return null
    const { parent_thread_id: parent, agent_nickname: nickname, agent_path: agentPath } = spawn.data.subagent.thread_spawn
    const ref: ThreadRef = {
      harness: "codex",
      nativeId: meta.id,
      path,
      bytes,
      updatedAt: new Date(mtimeMs).toISOString(),
      childOf: { nativeId: parent },
    }
    if (meta.cwd) ref.cwd = meta.cwd
    if (meta.timestamp) ref.startedAt = meta.timestamp
    const title = nickname ?? agentPath
    if (title) ref.title = title
    const edge = this.edges(parent, 0).find((candidate) => candidate.child === meta.id)
    if (edge?.title) ref.title = edge.title
    if (edge?.model) ref.model = edge.model
    return ref
  }

  /** Whether the state database has a row for the thread. */
  private knows(id: string): boolean {
    try {
      const database = this.source.stores.open(this.source.metadataPath, { timeout: READ_BUSY_TIMEOUT_MS })
      try {
        return Boolean(database.prepare("SELECT 1 FROM threads WHERE id = ?").get(id))
      } finally {
        database.close()
      }
    } catch {
      return false
    }
  }

  /** Spawn edges under `parentId`, then theirs, from the state database. */
  private edges(parentId: string, depth = MAX_DEPTH): Edge[] {
    let database
    try {
      database = this.source.stores.open(this.source.metadataPath, { timeout: READ_BUSY_TIMEOUT_MS })
    } catch {
      return []
    }
    try {
      const tables = new Set(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap((row) => TableRow.safeParse(row).data?.name ?? []))
      if (!tables.has("thread_spawn_edges") || !tables.has("threads")) return []
      const query = database.prepare(
        "SELECT e.child_thread_id AS child, e.parent_thread_id AS parent, e.status AS status, t.rollout_path AS rollout, t.title AS title, t.agent_nickname AS nickname, t.agent_role AS role, t.agent_path AS path, t.model AS model, t.created_at_ms AS created, t.updated_at_ms AS updated FROM thread_spawn_edges e LEFT JOIN threads t ON t.id = e.child_thread_id WHERE e.parent_thread_id = ?"
      )
      const found: Edge[] = []
      let level = [parentId]
      for (let at = 0; at <= depth && level.length; at++) {
        const next: string[] = []
        for (const parent of level)
          for (const raw of query.all(parent)) {
            const row = EdgeRow.safeParse(raw).data
            if (!row || found.some((edge) => edge.child === row.child)) continue
            const edge: Edge = { child: row.child, parent, closed: row.status === "closed" }
            if (row.rollout) edge.rolloutPath = row.rollout
            if (row.title) edge.title = row.title
            if (row.nickname) edge.nickname = row.nickname
            if (row.role) edge.role = row.role
            if (row.path) edge.path = row.path
            if (row.model) edge.model = row.model
            if (row.created) edge.createdAt = row.created
            if (row.updated) edge.updatedAt = row.updated
            found.push(edge)
            next.push(row.child)
          }
        level = next
      }
      return found
    } catch (error) {
      // A writer's lock says nothing about the edges: the listing is retried, never read as none.
      if (SqliteBusy.safeParse(error).success) throw new SessionUnreadable(this.source.metadataPath, { cause: error })
      throw error
    } finally {
      database.close()
    }
  }

}

/** Codex's current rollout of a thread: the one its state database names, else the newest. */
async function currentRollout(rollouts: readonly string[], id: string, named: string | undefined): Promise<string | undefined> {
  const candidates = rollouts.filter((file) => rolloutThread(file) === id)
  const current = namedRollout(candidates, named)
  if (current || candidates.length <= 1) return current ?? candidates[0]
  const stamped = await Promise.all(candidates.map(async (file) => ({ file, at: (await stat(file).catch(() => null))?.mtimeMs ?? 0 })))
  return stamped.sort((left, right) => right.at - left.at)[0]?.file
}