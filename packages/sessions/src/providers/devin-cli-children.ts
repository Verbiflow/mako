import type { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { boundedChildren, type ChildState, type ChildTranscript } from "../children.js"

/**
 * devin-cli's subagents. A subagent's messages are a chain of their own in
 * its session's `message_nodes` forest: a root system prompt ("You are a
 * subagent of Devin…"), its profile, then the task as a user message and
 * everything it did. Devin 3000.10 added `subagent_heads(session_id,
 * agent_id, chain_node_id)` to name each subagent's newest node; where that
 * row exists the chain is exact. The builds that wrote this Mac's sessions
 * left it empty, so a chain is matched by its task: the user message under
 * a subagent's system prompt that repeats the `run_subagent` call's `task`,
 * the longest such chain when a launch was retried.
 *
 * The session names each subagent in its `run_subagent` call's result
 * ("Background subagent started with agent_id=…", "Subagent agent_id=…
 * completed successfully") and in the completion notification it is sent
 * ("[Background subagent with agent_id=… completed]").
 */

/** How much of a task's start tells two tasks apart. */
const TASK_KEY = 512
const AGENT = /agent_id=([A-Za-z0-9_-]+)/
/** The tool that launches a subagent, as a stored call names it: a whole JSON string. */
const RUN_SUBAGENT = JSON.stringify("run_subagent")
const ENDED = /(?:Subagent agent_id=[A-Za-z0-9_-]+ (?:completed|failed)|\[Background subagent with agent_id=[A-Za-z0-9_-]+ (?:completed|failed|stopped|cancelled)[^\]]*\])/g
/** A JSON document kept as text; text that isn't JSON fails the parse. */
const JsonText = z.string().transform((raw, context) => {
  try {
    const value: unknown = JSON.parse(raw)
    return value
  } catch {
    context.addIssue({ code: "custom", message: "not JSON" })
    return z.NEVER
  }
})
const Args = z.object({ title: z.string().optional(), task: z.string().optional(), profile: z.string().optional(), resume: z.string().optional() })
/** A call's arguments, which devin-cli writes as a JSON string or an object. */
const CallArgs = z.union([JsonText.pipe(Args), Args]).optional().catch(undefined)
const Call = z.object({
  id: z.string(),
  name: z.string().optional(),
  function: z.object({ name: z.string().optional(), arguments: CallArgs }).optional(),
  arguments: CallArgs,
})
/** What a message's content says, as the text a notice or an agent id is searched in. */
const ContentText = z.union([z.string(), z.unknown().transform((value) => JSON.stringify(value ?? ""))])
const Message = JsonText.pipe(z.object({
  role: z.string().optional(),
  content: ContentText,
  tool_call_id: z.string().optional(),
  tool_calls: z.array(z.unknown()).optional(),
  metadata: z.object({ extensions: z.object({ "subagent/agent_id": z.string().optional().catch(undefined) }).optional().catch(undefined) }).nullish().catch(undefined),
}))
const TableRow = z.object({ name: z.string() })
const HeadRow = z.object({ agent_id: z.string(), chain_node_id: z.number() })
const LaunchRow = z.object({ node_id: z.number(), message: z.string().nullable(), summary: z.string().nullable() })
/**
 * The node a compaction's summary row names its history ending at. Every
 * other row of 3000.11.205 names none (`null`), which reads as `undefined`
 * rather than failing a `safeParse`.
 */
const Summary = JsonText.pipe(z.object({ summarized_from: z.number() })).optional().catch(undefined)

/** `<sessions.db>#<session>/subagents/<agent>`: a subagent's chain, read like a session's main chain. */
export function devinChildPath(path: string): { session: string; agentId: string; parentPath: string } | null {
  const match = /^(.*#([^#/]+))\/subagents\/([^/]+)$/.exec(path)
  return match?.[1] && match[2] && match[3] ? { parentPath: match[1], session: match[2], agentId: match[3] } : null
}

interface Launch {
  toolId: string
  title?: string
  task?: string
  role?: string
}

/** What the session's main chain says about its subagents. */
interface ParentLinks {
  /** Each subagent by the call that launched or resumed it. */
  launches: Map<string, Launch>
  /** Subagents a result or notification reported ended. */
  ended: Set<string>
}

function parentLinks(messages: readonly string[]): ParentLinks {
  const calls = new Map<string, Omit<Launch, "toolId">>()
  const launches = new Map<string, Launch>()
  const ended = new Set<string>()
  for (const raw of messages) {
    const message = Message.safeParse(raw).data
    if (!message) continue
    for (const value of message.tool_calls ?? []) {
      const call = Call.safeParse(value)
      if (!call.success || (call.data.name ?? call.data.function?.name) !== "run_subagent") continue
      const args = call.data.arguments ?? call.data.function?.arguments
      calls.set(call.data.id, { title: args?.title, task: args?.task, role: args?.profile })
      if (args?.resume && !launches.has(args.resume)) launches.set(args.resume, { toolId: call.data.id, title: args.title, role: args.profile })
    }
    const text = message.content
    for (const [notice] of text.matchAll(ENDED)) {
      const agent = AGENT.exec(notice)?.[1]
      if (agent) ended.add(agent)
    }
    const call = message.tool_call_id ? calls.get(message.tool_call_id) : undefined
    if (!call || !message.tool_call_id) continue
    const agent = message.metadata?.extensions?.["subagent/agent_id"] ?? AGENT.exec(text.slice(0, 512))?.[1]
    if (agent && !launches.has(agent)) launches.set(agent, { toolId: message.tool_call_id, ...call })
  }
  return { launches, ended }
}

/** Where a subagent's chain is found: its newest node by `subagent_heads`, or its prompt node by its task. */
type ChainStart = { head: number; exact: true } | { prompt: number; exact: false; ambiguous?: true }

interface Analysis {
  revision: number
  launches: Map<string, Launch>
  ended: Set<string>
  starts: Map<string, ChainStart>
}

/**
 * What a session says about its subagents and where each one's chain is,
 * kept per session while its newest row holds. Finding the launches reads
 * the main chain's messages, which for a long session is most of the
 * database, so it runs when a session's children are listed and is reused
 * by every read and follow of a child until the session grows.
 */
export class DevinChildLinks {
  private readonly held = new Map<string, Analysis>()
  private readonly forests = new Map<string, Forest>()

  children(db: DatabaseSync, session: string, parentPath: string): ChildTranscript[] {
    const { launches, ended, starts } = this.analysis(db, session)
    const children: ChildTranscript[] = []
    for (const agent of new Set([...launches.keys(), ...starts.keys()])) {
      const launch = launches.get(agent)
      const start = starts.get(agent)
      const child: ChildTranscript = { nativeId: agent, state: devinChildState(start, ended.has(agent)) }
      if (start) child.path = `${parentPath}/subagents/${agent}`
      if (launch?.toolId) child.toolId = launch.toolId
      if (launch?.title) child.title = launch.title
      if (launch?.role) child.role = launch.role
      children.push(child)
    }
    return boundedChildren(children).children
  }

  /**
   * Whether the session can have a subagent: its store heads one, or one of
   * `chain`'s messages (its main chain, compactions' earlier chains included,
   * as a read already holds it) holds the JSON string `"run_subagent"`, as
   * a call to it does. Every subagent `children` lists has a head or a
   * launch, and a launch is such a call, so a session with neither lists
   * none, and nothing need read its forest. The system prompt names the
   * tool too, but only inside its text, where no quote closes the name.
   */
  mayHaveChildren(db: DatabaseSync, session: string, chain: Iterable<string | undefined>): boolean {
    for (const message of chain) if (message?.includes(RUN_SUBAGENT)) return true
    try {
      return db.prepare("SELECT 1 FROM subagent_heads WHERE session_id = ? LIMIT 1").get(session) !== undefined
    } catch {
      // A database from before `subagent_heads` names no heads.
      return false
    }
  }

  /** A subagent's newest node, for reading its chain; -1 when none is found. */
  leaf(db: DatabaseSync, session: string, agentId: string): number {
    const head = headOf(db, session, agentId)
    if (head !== undefined) return head
    // A chain's prompt node never moves; only its newest node does.
    const start = (this.held.get(session) ?? this.analysis(db, session)).starts.get(agentId)
    if (!start) return -1
    return start.exact ? start.head : deepestUnder(this.forest(db, session).children, start.prompt)
  }

  /**
   * The session's nodes by parent, from the two columns that place them.
   * Reading even those touches every row's first page, five seconds for a
   * session of a hundred thousand nodes, so rows are taken past the newest
   * one already held: nodes are only ever added.
   */
  private forest(db: DatabaseSync, session: string): Forest {
    const held = this.forests.get(session) ?? { after: 0, parents: new Map(), children: new Map() }
    for (const row of db.prepare("SELECT row_id, node_id, parent_node_id FROM message_nodes WHERE session_id = ? AND row_id > ? ORDER BY row_id").all(session, held.after)) {
      held.after = Number(row["row_id"])
      const id = Number(row["node_id"])
      const parent = row["parent_node_id"] === null ? null : Number(row["parent_node_id"])
      held.parents.set(id, parent)
      if (parent !== null) held.children.set(parent, [...(held.children.get(parent) ?? []), id])
    }
    this.forests.delete(session)
    this.forests.set(session, held)
    const oldest = this.forests.keys().next().value
    if (this.forests.size > 8 && oldest !== undefined) this.forests.delete(oldest)
    return held
  }

  /**
   * The messages of the main chain that can name a subagent, compactions'
   * earlier chains included. The chain is walked in the forest and only rows
   * holding `run_subagent` or `agent_id=` come back from the database.
   */
  private launchMessages(db: DatabaseSync, session: string, forest: Forest): string[] {
    // Segments newest first; a compaction's summary row names the node the earlier one ends at. A store from before
    // `message_nodes.metadata` has no compaction summaries to name one; the chain reader reads it the same way.
    const summaries = db.prepare("PRAGMA table_info(message_nodes)").all().some((row) => TableRow.safeParse(row).data?.name === "metadata")
    // Each row is read once, for both what it says and whether it is a summary.
    const messages: Array<{ at: number; text: string }> = []
    const seen = new Set<number>()
    let position = 0
    let leaf: number | undefined = Number(db.prepare("SELECT COALESCE(main_chain_id, -1) AS leaf FROM sessions WHERE id = ?").get(session)?.["leaf"] ?? -1)
    while (leaf !== undefined && leaf >= 0 && !seen.has(leaf)) {
      const segment: number[] = []
      for (let at: number | null | undefined = leaf; at !== null && at !== undefined && !seen.has(at); at = forest.parents.get(at)) {
        seen.add(at)
        segment.push(at)
      }
      // Oldest first, as the chain was written: a call precedes its result.
      const order = new Map(segment.map((id, index) => [id, position - index]))
      position -= segment.length
      leaf = undefined
      for (let start = 0; start < segment.length; start += 500) {
        const chunk = segment.slice(start, start + 500)
        const rows = db.prepare(
          `SELECT node_id,
             CASE WHEN instr(chat_message, 'run_subagent') > 0 OR instr(chat_message, 'agent_id=') > 0 THEN chat_message END AS message,
             ${summaries ? "CASE WHEN instr(metadata, 'summarized_from') > 0 THEN metadata END" : "NULL"} AS summary
           FROM message_nodes WHERE session_id = ? AND node_id IN (${chunk.map(() => "?").join(", ")})`
        ).all(session, ...chunk)
        for (const raw of rows) {
          const row = LaunchRow.safeParse(raw).data
          if (!row) continue
          if (row.message !== null) messages.push({ at: order.get(row.node_id) ?? 0, text: row.message })
          if (row.summary !== null) leaf ??= Summary.parse(row.summary)?.summarized_from
        }
      }
    }
    return messages.sort((left, right) => left.at - right.at).map((message) => message.text)
  }

  private analysis(db: DatabaseSync, session: string): Analysis {
    const revision = Number(db.prepare("SELECT max(row_id) AS at FROM message_nodes WHERE session_id = ?").get(session)?.["at"] ?? 0)
    const held = this.held.get(session)
    if (held?.revision === revision) return held
    const forest = this.forest(db, session)
    const { launches, ended } = parentLinks(this.launchMessages(db, session, forest))
    const starts = new Map<string, ChainStart>()
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().flatMap((row) => TableRow.safeParse(row).data?.name ?? []))
    if (tables.has("subagent_heads"))
      for (const raw of db.prepare("SELECT agent_id, chain_node_id FROM subagent_heads WHERE session_id = ?").all(session)) {
        const row = HeadRow.safeParse(raw).data
        if (row) starts.set(row.agent_id, { head: row.chain_node_id, exact: true })
      }
    const wanted = [...launches].filter(([agent, launch]) => !starts.has(agent) && launch.task)
    if (wanted.length) {
      const prompts = subagentPrompts(db, session, forest)
      const counts = new Map<string, number>()
      for (const [, { task }] of wanted) if (task) counts.set(taskKey(task), (counts.get(taskKey(task)) ?? 0) + 1)
      for (const [agent, { task }] of wanted) {
        const prompt = task ? prompts.get(taskKey(task)) : undefined
        if (prompt === undefined || !task) continue
        starts.set(agent, (counts.get(taskKey(task)) ?? 0) > 1 ? { prompt, exact: false, ambiguous: true } : { prompt, exact: false })
      }
    }
    const analysis: Analysis = { revision, launches, ended, starts }
    this.held.delete(session)
    this.held.set(session, analysis)
    const oldest = this.held.keys().next().value
    if (this.held.size > 32 && oldest !== undefined) this.held.delete(oldest)
    return analysis
  }
}

function headOf(db: DatabaseSync, session: string, agentId: string): number | undefined {
  try {
    const row = db.prepare("SELECT chain_node_id AS head FROM subagent_heads WHERE session_id = ? AND agent_id = ?").get(session, agentId)
    return row ? Number(row["head"]) : undefined
  } catch {
    // A database from before `subagent_heads` names no heads.
    return undefined
  }
}

/** How a task is compared: the start of its text as JSON stores it. */
function taskKey(task: string): string {
  return JSON.stringify(task).slice(1, -1).slice(0, TASK_KEY)
}

interface Forest {
  /** The newest row read. */
  after: number
  parents: Map<number, number | null>
  children: Map<number, number[]>
}

/** The deepest node under `from`, and how deep: a retried launch's chains share a prompt, and the one that ran goes furthest. */
function deepest(children: ReadonlyMap<number, number[]>, from: number): { leaf: number; depth: number } {
  let best = { leaf: from, depth: 0 }
  const stack: Array<[number, number]> = [[from, 0]]
  for (let next = stack.pop(); next; next = stack.pop()) {
    const [node, depth] = next
    if (depth > best.depth) best = { leaf: node, depth }
    for (const child of children.get(node) ?? []) stack.push([child, depth + 1])
  }
  return best
}

function deepestUnder(children: ReadonlyMap<number, number[]>, from: number): number {
  return deepest(children, from).leaf
}

/**
 * Each subagent chain's prompt node by the start of its task: a user
 * message under nothing but system prompt, from a root that opens "You are
 * a subagent". Only nodes within four of a root are read, a kilobyte each;
 * a long session's tool output is never touched. When a task was launched
 * more than once, the chain that went furthest.
 */
function subagentPrompts(db: DatabaseSync, session: string, { parents, children }: Forest): Map<string, number> {
  const heads = new Map<number, string>()
  const read = db.prepare(`SELECT substr(chat_message, 1, ${TASK_KEY + 512}) AS head FROM message_nodes WHERE session_id = ? AND node_id = ?`)
  for (const [id] of parents) {
    let depth = 0
    for (let at = parents.get(id); at !== null && at !== undefined && depth <= 4; at = parents.get(at)) depth++
    if (depth <= 4) heads.set(id, String(read.get(session, id)?.["head"] ?? ""))
  }
  const role = (id: number) => /"role"\s*:\s*"(\w+)"/.exec(heads.get(id) ?? "")?.[1]
  const prompts = new Map<string, { node: number; depth: number }>()
  for (const [id, head] of heads) {
    if (role(id) !== "user") continue
    let at = parents.get(id) ?? null
    let root: number | undefined
    while (at !== null && role(at) === "system") {
      root = at
      at = parents.get(at) ?? null
    }
    if (at !== null || root === undefined || !/"content"\s*:\s*"You are a subagent/.test(heads.get(root) ?? "")) continue
    const opening = /"content"\s*:\s*"/.exec(head)
    if (!opening) continue
    const start = opening.index + opening[0].length
    // The string ends at the first quote no backslash escapes.
    const closing = /(?<!\\)(?:\\\\)*"/.exec(head.slice(start))
    const key = head.slice(start, start + Math.min(closing ? closing.index + closing[0].length - 1 : TASK_KEY, TASK_KEY))
    const found = deepest(children, id)
    const held = prompts.get(key)
    if (!held || found.depth > held.depth) prompts.set(key, { node: id, depth: found.depth })
  }
  return new Map([...prompts].map(([key, { node }]) => [key, node]))
}

function devinChildState(start: ChainStart | undefined, ended: boolean): ChildState {
  if (!start) return { kind: "missing", reason: "Devin CLI kept no chain for this subagent in the session." }
  if (!start.exact && start.ambiguous) return { kind: "partial", reason: "Devin CLI recorded no head for this subagent, and another one was given the same task: its chain may be the other's." }
  if (!start.exact) return { kind: "partial", reason: "Devin CLI recorded no head for this subagent; its chain was matched by its task." }
  return ended ? { kind: "complete" } : { kind: "partial", reason: "Devin CLI hasn't recorded this subagent's end: it is still running, or stopped without reporting." }
}