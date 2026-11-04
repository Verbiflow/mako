import { z } from "zod"
import type { AgentsStarted } from "@mako/host/contracts/agent-tools"
import type { JsonValue } from "@mako/host/contracts/json"
import { NATIVE_CHILD_INSTRUCTIONS, routeNativeSpawn, type RoutedThread } from "@mako/host/contracts/native-routing"
import { ClaudeAgentInput, claudeSpawn } from "@mako/host/harnesses/claude/routing"
import { priorTurns, ToolArgs, turnText, type OrchCase, type Sample } from "./cases.ts"
import { bareName, isShell, makoTool, shellCommand } from "./names.ts"
import { startedAlready, stubAnswer, type StubMako } from "./stub-mako.ts"
import { readTemplate } from "./templates.ts"

/**
 * T3 Code's method for Claude and Codex: the harness's own captured prompt
 * and tools (`templates/`), Mako's `mako` server as it describes itself, the
 * case's Thread, and the model's decisions, step by step. Nothing runs:
 * `agents_*` and `thread_move` get the stub's answers, a native spawn its routed deny (an Apex,
 * routing on) or a finished subagent, the shell the case's mocks or nothing.
 * Routing on is the control (Claude's deny, Codex's Apex tools) and the
 * native-Fin words; off leaves Mako's instructions alone.
 */

export const REPLAY_HARNESSES = ["claude", "codex"] as const
export type ReplayHarness = (typeof REPLAY_HARNESSES)[number]
export type Described = Awaited<ReturnType<StubMako["describe"]>>
type Routing = "on" | "off"
type Measured = Sample & { tokens: { input: number; output: number } }

const role = (orchCase: OrchCase): RoutedThread["role"] => orchCase.setup.role === "apex" ? "apex" : "thread"
const MCP_HEADING = "# MCP Server Instructions\n\nThe following MCP servers have provided instructions for how to use their tools and resources:\n\n## mako\n"
const NOTHING = "(no output)"
const Usage = z.looseObject({ input_tokens: z.number(), output_tokens: z.number() })

function shellOutput(orchCase: OrchCase, command: string): string {
  return orchCase.setup.shellMocks?.find((mock) => new RegExp(mock.match).test(command))?.output ?? NOTHING
}

/** The case's Thread so far, and its prompt, as the person's turns and the agent's replies. */
function turns(orchCase: OrchCase): { role: "user" | "assistant"; text: string }[] {
  const prior = priorTurns(orchCase).map((turn) => ({
    role: turn.role,
    text: turn.toolCalls?.length ? `${turn.text}\n\n${turn.toolCalls.map((call) => `[${call.tool} ${JSON.stringify(call.input)} → ${JSON.stringify(call.result)}]`).join("\n")}` : turn.text,
  }))
  const world = orchCase.setup.world ? `\n\n<world>${JSON.stringify(orchCase.setup.world)}</world>` : ""
  const child = orchCase.setup.role === "native-subagent" ? "You are a subagent your parent agent started for this task.\n\n" : ""
  return [...prior, { role: "user", text: `${child}${turnText(orchCase)}${world}` }]
}

/** What a call gets back: the stub's answer, a native spawn's routed deny or a finished subagent, the shell's mock. */
function answerer(harness: ReplayHarness, orchCase: OrchCase, routing: Routing) {
  const started: AgentsStarted[] = startedAlready((orchCase.setup.children ?? []).map((child) => child.name))
  const thread: RoutedThread = { role: role(orchCase) }
  return (tool: string, raw: string, args: ToolArgs): string => {
    if (makoTool(tool)) return JSON.stringify(stubAnswer(tool, args, started))
    if (tool === "native_spawn") {
      if (harness === "claude" && routing === "on") {
        const spawn = claudeSpawn(raw, ClaudeAgentInput.parse(args), false)
        const route = spawn && routeNativeSpawn(thread, spawn)
        if (route?.kind === "deny") return route.message
      }
      return "The subagent finished its task."
    }
    if (isShell(harness, raw)) return shellOutput(orchCase, shellCommand(args))
    return "ok"
  }
}

async function post(url: string, headers: Record<string, string>, body: JsonValue): Promise<JsonValue> {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${new URL(url).host} answered ${response.status}: ${(await response.text()).slice(0, 300)}`)
  return z.json().parse(await response.json())
}

// --- Claude: the Messages API, as Claude Code sends it.

const ClaudeReply = z.looseObject({ content: z.array(z.json()), usage: Usage })
const ClaudeBlock = z.looseObject({ type: z.string(), text: z.string().optional() })
const ClaudeToolUse = z.looseObject({ type: z.literal("tool_use"), id: z.string(), name: z.string(), input: z.json() })

function claudeBody(orchCase: OrchCase, routing: Routing, mako: Described, model: string) {
  const template = readTemplate("claude")
  const system = z.array(z.json()).parse(template.system)
  const tools = z.array(z.json()).parse(template.tools)
  // Where Claude Code puts SubagentStart's additionalContext: after the child's task.
  const reminder = orchCase.setup.role === "native-subagent" && routing === "on"
    ? [{ type: "text", text: `<system-reminder>\nSubagentStart hook additional context: ${NATIVE_CHILD_INSTRUCTIONS}\n</system-reminder>` }]
    : []
  const thread = turns(orchCase)
  const messages: { role: "user" | "assistant"; content: JsonValue }[] = thread.map((turn, index) => ({
    role: turn.role,
    content: [{ type: "text", text: turn.text }, ...index === thread.length - 1 ? reminder : []],
  }))
  return {
    ...template, model, stream: false,
    system: [...system, { type: "text", text: MCP_HEADING + mako.instructions }],
    tools: [...tools, ...mako.tools.map((tool) => ({ name: `mcp__mako__${tool.name}`, description: tool.description, input_schema: tool.inputSchema }))],
    messages,
  }
}

async function claudeSample(orchCase: OrchCase, routing: Routing, mako: Described, model: string, key: string, maxSteps: number): Promise<Measured> {
  const sample: Measured = { steps: [], shell: [], text: "", ended: false, tokens: { input: 0, output: 0 } }
  const answer = answerer("claude", orchCase, routing)
  const body = claudeBody(orchCase, routing, mako, model)
  for (let step = 0; step < maxSteps; step++) {
    const reply = ClaudeReply.parse(await post("https://api.anthropic.com/v1/messages", { "x-api-key": key, "anthropic-version": "2023-06-01" }, body))
    sample.tokens.input += reply.usage.input_tokens
    sample.tokens.output += reply.usage.output_tokens
    sample.text += reply.content.flatMap((block) => ClaudeBlock.safeParse(block).data?.text ?? []).join("\n")
    const calls = reply.content.flatMap((block) => ClaudeToolUse.safeParse(block).data ?? []).map((use) => ({ raw: use.name, tool: bareName("claude", use.name), args: ToolArgs.parse(use.input), id: use.id }))
    if (!calls.length) {
      sample.ended = true
      break
    }
    sample.steps.push(calls.map(({ tool, args }) => ({ tool, args })))
    for (const call of calls) if (isShell("claude", call.raw)) sample.shell.push(shellCommand(call.args))
    body.messages.push({ role: "assistant", content: reply.content }, { role: "user", content: calls.map((call) => ({ type: "tool_result", tool_use_id: call.id, content: answer(call.tool, call.raw, call.args) })) })
  }
  return sample
}

// --- Codex: the Responses API, as Codex's app-server sends it.

const CodexReply = z.looseObject({ output: z.array(z.json()), usage: Usage })
const CodexMessage = z.looseObject({ type: z.literal("message"), content: z.array(z.looseObject({ text: z.string().optional() })) })
const CodexCall = z.union([
  z.looseObject({ type: z.literal("function_call"), name: z.string(), call_id: z.string(), arguments: z.string() })
    .transform((call) => ({ raw: call.name, id: call.call_id, args: ToolArgs.parse(JSON.parse(call.arguments)), output: "function_call_output" })),
  z.looseObject({ type: z.literal("custom_tool_call"), name: z.string(), call_id: z.string(), input: z.string() })
    .transform((call) => ({ raw: call.name, id: call.call_id, args: { command: call.input }, output: "custom_tool_call_output" })),
])
const AdditionalTools = z.looseObject({ type: z.literal("additional_tools"), tools: z.array(z.json()) })

function codexBody(orchCase: OrchCase, routing: Routing, mako: Described, model: string) {
  const template = readTemplate(routing === "on" && role(orchCase) === "apex" ? "codex-lead" : "codex")
  const namespace = { type: "namespace", name: "mcp__mako__", description: mako.instructions, tools: mako.tools.map((tool) => ({ type: "function", name: tool.name, description: tool.description, strict: false, parameters: tool.inputSchema })) }
  const captured = z.array(z.json()).parse(template.input).map((item): JsonValue => {
    const listed = AdditionalTools.safeParse(item)
    return listed.success ? { ...z.record(z.string(), z.json()).parse(item), tools: [...listed.data.tools, namespace] } : item
  })
  const input: JsonValue[] = [...captured, ...turns(orchCase).map((turn) => ({ type: "message", role: turn.role, content: [{ type: turn.role === "user" ? "input_text" : "output_text", text: turn.text }] }))]
  return { ...template, model, stream: false, store: false, input }
}

async function codexSample(orchCase: OrchCase, routing: Routing, mako: Described, model: string, key: string, maxSteps: number): Promise<Measured> {
  const sample: Measured = { steps: [], shell: [], text: "", ended: false, tokens: { input: 0, output: 0 } }
  const answer = answerer("codex", orchCase, routing)
  const body = codexBody(orchCase, routing, mako, model)
  for (let step = 0; step < maxSteps; step++) {
    const reply = CodexReply.parse(await post("https://api.openai.com/v1/responses", { authorization: `Bearer ${key}` }, body))
    sample.tokens.input += reply.usage.input_tokens
    sample.tokens.output += reply.usage.output_tokens
    sample.text += reply.output.flatMap((item) => CodexMessage.safeParse(item).data?.content.flatMap((part) => part.text ?? []) ?? []).join("\n")
    const calls = reply.output.flatMap((item) => CodexCall.safeParse(item).data ?? []).map((call) => ({ ...call, tool: bareName("codex", call.raw) }))
    if (!calls.length) {
      sample.ended = true
      break
    }
    sample.steps.push(calls.map(({ tool, args }) => ({ tool, args })))
    for (const call of calls) if (isShell("codex", call.raw) || call.raw === "exec") sample.shell.push(shellCommand(call.args))
    body.input.push(...reply.output, ...calls.map((call) => ({ type: call.output, call_id: call.id, output: answer(call.tool, call.raw, call.args) })))
  }
  return sample
}

/** The first request each case sends, at $0: what `--dry-run` writes and CI builds on every change. */
export function firstRequest(harness: ReplayHarness, orchCase: OrchCase, routing: Routing, mako: Described, model: string) {
  return harness === "claude" ? claudeBody(orchCase, routing, mako, model) : codexBody(orchCase, routing, mako, model)
}

export interface ReplayKeys {
  anthropic?: string
  openai?: string
}

/** One sample, run against the model's own API until the turn ends or `maxSteps` pass. */
export function replaySample(harness: ReplayHarness, orchCase: OrchCase, routing: Routing, mako: Described, model: string, keys: ReplayKeys, maxSteps = 6): Promise<Measured> {
  const key = harness === "claude" ? keys.anthropic : keys.openai
  if (!key) throw new Error(`The ${harness} replay needs ${harness === "claude" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}`)
  return harness === "claude" ? claudeSample(orchCase, routing, mako, model, key, maxSteps) : codexSample(orchCase, routing, mako, model, key, maxSteps)
}
