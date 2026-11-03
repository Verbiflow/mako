import { randomUUID } from "node:crypto"
import { z } from "zod"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { AFTER_START, AGENT_TOOLS, type AgentsAnswered, type AgentsListResult, type AgentsSent, type AgentsStarted, type AgentsWaitResult, type AgentToolDefinition } from "@mako/host/contracts/agent-tools"
import type { JsonValue } from "@mako/host/contracts/json"
import { registerAgentTools, type AgentAnswer } from "@mako/host/conversations/agent-tools"
import { startConversationMcp, type MakoTools } from "@mako/host/tools/conversation-mcp"
import type { CallThread } from "@mako/host/contracts/native-calls"
import { callGateAnswer, HookCall } from "@mako/host/harnesses/call-gate"
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { registerWorkspaceTools, type WorkspaceTools } from "@mako/host/workspaces/tools"
import { registerEnvironmentTools, type EnvironmentTools } from "@mako/host/workspaces/environment-tools"
import { registerPullRequestTools, type PullRequestTools } from "@mako/host/git/pull-request-tools"
import { ToolArgs, type Call } from "./cases.ts"

/**
 * Mako's own `mako` server for the eval: the conversation server a Thread's
 * agent reaches, with every `agents_*` tool as `registerAgentTools` projects
 * it from `AGENT_TOOLS` (so the shapes can't drift), answered by a door that
 * records each call and starts nothing. A start answers as a running child
 * would; a list, the children started so far.
 */
export interface StubMako {
  /** The grant one launch's agent gets (`ConversationTools`). */
  grant(conversation: string): { token: string; computerUrl: string; makoUrl?: string }
  /** The Thread a conversation's hooks are answered for at the `/calls` gate, as routing reads it. */
  routes(conversation: string, thread: CallThread): void
  /** A case's own answers to Mako's tools, over `FAMILY_ANSWERS`. */
  answers(conversation: string, answers: Record<string, string>): void
  /** The `agents_*` calls so far, by bare tool name. */
  calls(conversation: string): Call[]
  /** What an agent reads first: the server's instructions and its tools. */
  describe(): Promise<{ instructions: string; tools: { name: string; description: string; inputSchema: JsonValue }[] }>
  close(): Promise<void>
}

const toolOf = (channel: AgentToolDefinition["channel"]) => AGENT_TOOLS.find((tool) => tool.channel === channel)!.mcp.name

/** What the stub answers a call, given the children it started for the same conversation. */
const Named = z.object({ name: z.string().optional() }).catch({})
const Sent = z.object({ to: z.string().optional() }).catch({})

/** An Apex's Fins a case starts with, as the stub lists them. */
export function startedAlready(names: readonly string[]): AgentsStarted[] {
  return names.map((name, index) => ({ child: randomUUID(), name, state: "working", tree: { running: index + 1, started: index + 1, of: { running: 8, started: 32 } }, next: AFTER_START }))
}

export function stubAnswer(tool: string, args: ToolArgs, started: AgentsStarted[]): AgentAnswer {
  const tree = { running: started.length, started: started.length, of: { running: 8, started: 32 } }
  if (tool === "agents_start") {
    const name = Named.parse(args).name ?? `child-${started.length + 1}`
    const child: AgentsStarted = { child: randomUUID(), name, state: "working", tree: { ...tree, running: tree.running + 1, started: tree.started + 1 }, next: AFTER_START }
    started.push(child)
    return { ...child }
  }
  if (tool === "agents_list") {
    const listed: AgentsListResult = {
      children: started.map((child) => ({ child: child.child ?? child.name, name: child.name, harness: "codex", origin: "started", state: { kind: "working" }, startedAt: Date.now() - 60_000 })),
      tree,
    }
    return { ...listed }
  }
  if (tool === "agents_send") {
    const to = Sent.parse(args).to ?? "child"
    const sent: AgentsSent = { child: randomUUID(), name: to.replace(/^child:/, ""), request: randomUUID(), delivery: "turn" }
    return { ...sent }
  }
  if (tool === "agents_answer") {
    const answer = z.object({ to: z.string().optional(), person: z.boolean().optional(), allow: z.boolean().optional() }).catch({}).parse(args)
    const answered: AgentsAnswered = { child: randomUUID(), name: (answer.to ?? "child").replace(/^fin:/, ""), answered: answer.person ? "person" : answer.allow === undefined ? "question" : "approval" }
    return { ...answered }
  }
  if (tool === "agents_wait") {
    const waited: AgentsWaitResult = { reports: [], cursor: 0, timedOut: true }
    return { ...waited }
  }
  return { ok: true }
}

/**
 * What the stub answers each of Mako's other tools: what a Thread hears when
 * the call goes as it should, so the turn can go on from there.
 */
const FAMILY_ANSWERS = new Map<string, string>([
  ["worktree_status", "checkout: main checkout\nfolder: the project\nbranch: main\nuncommitted: none\nworktree: none yet; worktree_move makes this Thread's own"],
  ["worktree_move", "Asked to move this Thread into its own worktree on branch mako/thread-work. The user answers in the app; once your turn ends, the conversation goes on there with this Thread's changes."],
  ["worktree_update", "Merged main into mako/thread-work: 3 commits, no conflicts."],
  ["worktree_merge", "Merged mako/thread-work into main in the main checkout."],
  ["worktree_bring", "Brought .env.local (copied)."],
  ["worktree_remove", "The worktree is removed once your turn ends; the branch stays."],
  ["pull_request_status", "pull request: #42 Fix login redirect (open)\nchecks: 4 passed, 1 failed\nfailed: lint (eslint: src/login.ts:12 no-unused-vars)\nreviews: none"],
  ["pull_request_open", "Pushed mako/thread-work and opened https://github.com/acme/app/pull/42."],
  ["pull_request_merge", "Merged #42 into main (squash)."],
  ["app_status", "address: http://thread.localhost:20540\nprocesses: web stopped, api stopped\nrecipe: ready (web on 20540, api on 20541); checks quick, full"],
  ["app_start", "Started web on 20540 and api on 20541: http://thread.localhost:20540 answers 200."],
  ["app_stop", "Stopped web and api."],
  ["app_restart", "Restarted web and api: http://thread.localhost:20540 answers 200."],
  ["app_logs", "web: ready in 812 ms on http://thread.localhost:20540"],
  ["app_probe", "GET http://thread.localhost:20540/ → 200 (1.2 kB, 34 ms)"],
  ["app_check", "quick: passed in 41 s"],
  ["app_own_packages", "node_modules is now this checkout's own copy."],
  ["recipe_guide", "A recipe says how every Thread installs, starts and checks the app. Save a draft with recipe_save: processes (name, command, port), checks, carry."],
  ["recipe_save", "Saved a draft recipe for this Thread."],
  ["recipe_publish", "Published the recipe for every Thread."],
  ["port_holder", "Port 3000 is held by pid 4121 (node vite), started by another Thread's app (Thread \"Settings polish\"). Don't stop it; this Thread's app runs on 20540-20549."],
  ["thread_history", "No earlier turns match."],
])

/** Registers Mako's own tools as the host does, with each call recorded and answered from `FAMILY_ANSWERS`. */
function familyTools(record: (conversation: string, tool: string, args: ToolArgs) => void, answers: (conversation: string) => Map<string, string> | undefined): MakoTools[] {
  const unused = new Proxy({}, { get: () => () => { throw new Error("The eval's stub answers before any tool runs") } })
  // Each request builds its own server, so its `registerTool` is replaced for that server alone.
  const recording = (server: McpServer, conversationId: () => string): McpServer => {
    type Register = (name: string, config: Parameters<McpServer["registerTool"]>[1], handler: (args: ToolArgs) => Promise<{ content: { type: "text"; text: string }[] }>) => ReturnType<McpServer["registerTool"]>
    // SAFETY: every handler the stub registers takes the tool's arguments and returns text, which each overload accepts.
    const register = server.registerTool.bind(server) as Register
    const stubbed = (name: string, config: Parameters<McpServer["registerTool"]>[1]) => register(name, config, async (args) => {
      record(conversationId(), name, ToolArgs.parse(args))
      return { content: [{ type: "text" as const, text: answers(conversationId())?.get(name) ?? FAMILY_ANSWERS.get(name) ?? "Done." }] }
    })
    // SAFETY: the register functions call `registerTool(name, config, handler)` only, which `stubbed` takes, dropping the handler.
    server.registerTool = stubbed as McpServer["registerTool"]
    return server
  }
  return [
    // SAFETY: every handler is replaced before it can run, so the tools' implementations are never read.
    (server, conversationId) => registerWorkspaceTools(recording(server, conversationId), unused as WorkspaceTools, conversationId),
    // SAFETY: as above.
    (server, conversationId) => registerEnvironmentTools(recording(server, conversationId), unused as EnvironmentTools, conversationId),
    // SAFETY: as above.
    (server, conversationId) => registerPullRequestTools(recording(server, conversationId), unused as PullRequestTools, conversationId, () => false),
  ]
}

export async function startStubMako(): Promise<StubMako> {
  const calls = new Map<string, Call[]>()
  const started = new Map<string, AgentsStarted[]>()
  const threads = new Map<string, CallThread>()
  const caseAnswers = new Map<string, Map<string, string>>()
  const record = (conversation: string, tool: string, args: ToolArgs) => calls.set(conversation, [...calls.get(conversation) ?? [], { tool, args }])
  const servers = await startConversationMcp(
    { authorizeAgent() {} },
    async (bindingId, operation) => {
      record(bindingId.replace(/^eval-/, ""), "js", ToolArgs.parse(operation))
      return { ok: true, result: "The page loaded; the screenshot is in the result." }
    },
    [...familyTools(record, (conversation) => caseAnswers.get(conversation)), (server, conversationId) => registerAgentTools(server, {
      invoke: async (channel, [, input]) => {
        const conversation = conversationId()
        const tool = toolOf(channel)
        const args = ToolArgs.parse(input)
        calls.set(conversation, [...calls.get(conversation) ?? [], { tool, args }])
        const children = started.get(conversation) ?? []
        started.set(conversation, children)
        return stubAnswer(tool, args, children)
      },
      caller: () => ({ kind: "agent", session: conversationId() }),
      filled: () => ({}),
    })],
    (conversation, event, body) => {
      const thread = threads.get(conversation)
      return thread ? callGateAnswer(event, HookCall.safeParse(body).data, thread, conversation) : {}
    },
  )
  const grants = new Map<string, ReturnType<typeof servers.mint>>()
  return {
    grant(conversation) {
      const grant = servers.mint(`eval-${conversation}`, conversation)
      grants.set(conversation, grant)
      return grant
    },
    routes: (conversation, thread) => { threads.set(conversation, thread) },
    answers: (conversation, answers) => { caseAnswers.set(conversation, new Map(Object.entries(answers))) },
    calls: (conversation) => calls.get(conversation) ?? [],
    async describe() {
      const conversation = `describe-${randomUUID()}`
      const grant = servers.mint(`eval-${conversation}`, conversation)
      const client = new Client({ name: "eval-orch-tools", version: "1.0.0" })
      await client.connect(new StreamableHTTPClientTransport(new URL(grant.makoUrl!), { requestInit: { headers: { authorization: `Bearer ${grant.token}` } } }))
      try {
        const listed = await client.listTools()
        return {
          instructions: client.getInstructions() ?? "",
          tools: listed.tools.map((tool) => ({ name: tool.name, description: tool.description ?? "", inputSchema: z.json().parse(tool.inputSchema) })),
        }
      } finally {
        await client.close()
        servers.revoke(`eval-${conversation}`, conversation)
      }
    },
    async close() {
      for (const [conversation] of grants) servers.revoke(`eval-${conversation}`, conversation)
      servers.close()
    },
  }
}
