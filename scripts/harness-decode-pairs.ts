import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, extname, join, relative } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { promisify } from "node:util"
import { z } from "zod"
import type { SessionNotification } from "@agentclientprotocol/sdk"
import { query, type Query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { AcpCompaction, compactionOutcome } from "../electron/acp-compaction.ts"
import { acpPromptBlocks } from "../electron/acp-prompt.ts"
import type { PromptAttachment } from "../electron/contracts/providers-acp.ts"
import { claudeInputContent } from "../electron/providers/claude/input.ts"
import { codexInput } from "../electron/providers/codex/input.ts"
import { acpSessionNotificationSchema } from "../electron/acp-stream.ts"
import type { JsonObject, JsonValue } from "../electron/codex-app-json.ts"
import type { LiveActionResult } from "../electron/contracts/live-actions.ts"
import { resolveExecutable } from "../electron/executable.ts"
import { ProviderLaunchTrace } from "../electron/provider-launch.ts"
import { claudeAcknowledged } from "../electron/providers/claude/sdk-message-kinds.ts"
import { claudeSdkOptions } from "../electron/providers/claude/sdk-options.ts"
import { resolveCodexExecutable } from "../electron/providers/codex/executable.ts"
import { CodexRolloutCalls, codexRolloutDue } from "../electron/providers/codex/rollout-calls.ts"
import { CODEX_CLIENT_CAPABILITIES, codexCollaborationMode, codexInteractiveConfig } from "../electron/providers/codex/settings.ts"
import { OPENCODE_DEFAULT_MODE, openCodeAgentForMode, openCodeLaunchAccess } from "../electron/providers/opencode/access.ts"
import { resolveOpenCodeInstallation } from "../electron/providers/opencode/installation.ts"
import { openCodeMessageId, promptFiles } from "../electron/providers/opencode/live-driver.ts"
import { cursorSdkSelection, cursorSdkStateRoot, cursorSdkStorePath, normalizeCursorSdkModels, OPENCODE_PLAN_AGENT } from "@mako/sessions"
import { build } from "esbuild"
import { readCursorCliApiKey } from "../electron/providers/cursor/sdk/cli-keychain.ts"
import { CursorSdkClient } from "../electron/providers/cursor/sdk/client.ts"
import type { SdkEvent, SdkImage } from "../electron/providers/cursor/sdk/wire.ts"
import { startOpenCodeApi } from "../electron/providers/opencode/native-api.ts"
import { configureOpenCodePermissions } from "../electron/providers/opencode/permissions.ts"
import { devinAcpSource } from "../electron/providers/devin/acp.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { acpClientCapabilities, type ProviderAcpSource } from "../electron/providers/acp-source.ts"
import { describeLeaks, literally, machineIdentity, rewriteDatabase, scrubJsonLines, scrubTree, treeLeaks, type Substitution } from "./fixture-privacy.ts"
import { differences, liveDrawing, PairSchema, PAIRS_FOLDER, storeDrawing, storeReader, type Pair } from "./decode-compare.ts"
import { RpcMessage, rpcPeer, sandboxed, stop, strayStores, type Sandbox } from "./harness-sandbox.ts"
import { FIXTURE_ROOT, type Prompt, type PromptFile, type Recording } from "./native-decoding.ts"
import { scriptedModel } from "./scripted-model.ts"
import { planFile, SCENARIOS, script, STOP_AFTER_MS, type Control, type Need, type Scenario, type Script, type ToolVocabulary, type Turn } from "./decode-scenarios.ts"

/**
 * Records a live capture and the store the same session wrote, from a real
 * harness CLI running scripted turns in a sealed sandbox, and compares what
 * each draws.
 *
 *   npm run harness:decode-pairs                      every harness, every scenario
 *   npm run harness:decode-pairs -- grok shell-and-edit
 *   npm run harness:decode-pairs -- grok --write      keep what was recorded
 *
 * The harness launches as Mako launches it; its model is `scripted-model.ts`,
 * so no account is used and nothing is sent anywhere. `--write` keeps each
 * pair under `fixtures/native-decoding/<harness>/pairs/<scenario>/` with the
 * sandbox's paths replaced by `PAIR_ROOT` and the recording machine's identity
 * by stand-ins (`fixture-privacy.ts`), for `test:decoders` to compare on every
 * run; a pair that still identifies someone isn't kept. A rewritten pair
 * keeps the reasons its known differences had.
 */

const SANDBOX = "mako-decode-pairs"
/** Where a kept pair says the sandbox was. */
const PAIR_ROOT = "/tmp/mako-pair"
const TURN_MS = 120_000
const run = promisify(execFile)

/* -------------------------------------------------------------- recorders */

interface RecordedPair {
  version: string
  recording: Recording
  /** The session's store file, under the sandbox's home. */
  store: string
}

type Model =
  | { kind: "scripted"; tools: ToolVocabulary }
  /**
   * The harness's own model, for a harness whose model protocol the scripted
   * model doesn't speak; only the prompts steer it. `lacks` says why a
   * scenario's need has no tool.
   */
  | { kind: "own"; why: string; lacks: Partial<Record<Need, string>> }

interface Recorder {
  model: Model
  /** Each control a scenario can need: driven, or absent with why. */
  controls: Record<Control, "driven" | { absent: string }>
  /** The store files kept beside a pair: the session's own, not the harness's indexes or prompts. */
  keeps: (file: string) => boolean
  /** The folder `keeps` looks through, when the session needs more than its store's own folder. */
  storeFolder?: (store: string) => string
  record: (sandbox: Sandbox, scenario: Scenario) => Promise<RecordedPair>
  /** Credential values the run had, which nothing recorded may contain. Read here, never printed or kept. */
  secrets?: () => Promise<string[]>
}

/** Why `recorder` can't record `scenario`, or undefined when it can. */
function unrecordable(recorder: Recorder, scenario: Scenario): string | undefined {
  for (const control of scenario.controls ?? []) {
    const driven = recorder.controls[control]
    if (driven !== "driven") return driven.absent
  }
  if (recorder.model.kind === "own") {
    const { lacks, why } = recorder.model
    return scenario.scripted ? `${scenario.scripted}, and ${why}` : scenario.needs?.map((need) => lacks[need]).find(Boolean)
  }
  for (const need of scenario.needs ?? []) {
    const tool = recorder.model.tools[need]
    if ("absent" in tool) return tool.absent
  }
  return undefined
}

const GROK_TOOLS: ToolVocabulary = {
  read: (path, lines) => ({ name: "read_file", arguments: { target_file: path, ...lines } }),
  shell: (command, description) => ({ name: "run_terminal_command", arguments: { command, description } }),
  edit: (path, from, to) => ({ name: "search_replace", arguments: { file_path: path, old_string: from, new_string: to } }),
  viewImage: (path) => ({ name: "read_file", arguments: { target_file: path } }),
  todos: (items) => ({ name: "todo_write", arguments: { merge: false, todos: items } }),
  search: (pattern) => ({ name: "grep", arguments: { pattern } }),
  codeMode: { absent: "Grok 1.0.46 defines no tool that runs code calling its other tools (native-tools/grok-1.0.46.json)" },
  ask: (question) => ({ name: "ask_user_question", arguments: { questions: [{ question: question.question, options: question.options }] } }),
  plan: (plan) => [
    { call: (_tools, _project, heard) => ({ name: "write", arguments: { file_path: planFile("Grok", heard), content: plan } }) },
    { call: () => ({ name: "exit_plan_mode", arguments: {} }) },
    { text: "The plan is approved." },
  ],
}

const GrokRewound = z.object({ success: z.literal(true) }).loose()

/**
 * As Grok 1.0.46's pager rewinds (`rewind_execute_params`): forced past an
 * in-flight prompt, conversation only. Grok appends a `rewind_marker` to
 * `updates.jsonl` and sends the client nothing.
 */
async function grokRewind(call: AcpCall, sessionId: string, target: number): Promise<void> {
  const reply = await call("_x.ai/rewind/execute", { sessionId, targetPromptIndex: target, force: true, mode: "conversation_only" })
  if (!GrokRewound.safeParse(reply).success) throw new Error(`Grok did not rewind to turn ${target}: ${JSON.stringify(reply)?.slice(0, 300)}`)
}

/** Grok over ACP, as Mako's ACP source launches it. */
const grok: Recorder = {
  model: { kind: "scripted", tools: GROK_TOOLS },
  controls: { steer: "driven", rewind: "driven", compact: "driven" },
  keeps: (file) => /\/sessions\/[^/]+\/[^/]+\/(updates\.jsonl|summary\.json)$/.test(file),
  async record(sandbox, scenario) {
    const version = await versionOf("grok")
    const steps = script(scenario, GROK_TOOLS, sandbox.project)
    const model = await scriptedModel({
      answers: new Map([
        ["/v1/api-key", JSON.stringify({ redacted_api_key: "xai-...pair", user_id: "pair", name: "pair", acls: ["api-key:model:*", "api-key:endpoint:*"], api_key_blocked: false, api_key_disabled: false, team_blocked: false })],
        ["/v1/models", JSON.stringify({ object: "list", data: [] })],
      ]),
      reply: steps.reply,
    })
    const env: NodeJS.ProcessEnv = {
      ...sandbox.env, ...scenario.env, GROK_HOME: join(sandbox.home, ".grok"), XAI_API_KEY: "mako-decode-pair",
      GROK_XAI_API_BASE_URL: `${model.url}/v1`, GROK_CLI_CHAT_PROXY_BASE_URL: `${model.url}/v1`, GROK_MODELS_BASE_URL: `${model.url}/v1`,
    }
    try {
      const launch = await grokAcpSource.launch({ appPath: process.cwd(), execPath: process.execPath, cwd: sandbox.project, env, access: grokAcpSource.access?.default })
      if (!launch) throw new Error("Grok's ACP source declined to launch")
      launch.configureEnvironment?.(env)
      const wire = await acpSession({ command: launch.command, args: launch.args, env, cwd: sandbox.project, source: grokAcpSource, rewind: grokRewind }, scenario.turns)
      scripted("Grok", scenario, model.requests, steps)
      const [file] = await storeReader("grok", sandbox.home).discover()
      if (!file) throw new Error("Grok wrote no session to its store")
      return {
        version,
        recording: { harness: "grok", session: { settings: { model: null } }, native: { version, origin: "captured" }, ...wire },
        store: file.path,
      }
    } finally {
      await model.close()
    }
  },
}

const CLAUDE_TOOLS: ToolVocabulary = {
  read: (path, lines) => ({ name: "Read", arguments: { file_path: path, ...lines } }),
  shell: (command, description) => ({ name: "Bash", arguments: { command, description } }),
  edit: (path, from, to) => ({ name: "Edit", arguments: { file_path: path, old_string: from, new_string: to } }),
  viewImage: (path) => ({ name: "Read", arguments: { file_path: path } }),
  todos: { absent: "Claude Code defines its todo tools only with CLAUDE_CODE_ENABLE_TODO_TOOLS set, which Mako doesn't set (CLAUDE_VOCABULARY)" },
  search: { absent: "Claude Code 2.1.283 defines no file search tool as Mako launches it; its model searches through Bash (native-tools/claude-2.1.283.json)" },
  codeMode: { absent: "Claude Code 2.1.283 defines no tool that runs code calling its other tools (native-tools/claude-2.1.283.json)" },
  ask: (question) => ({ name: "AskUserQuestion", arguments: { questions: [{ ...question, multiSelect: false }] } }),
  plan: (plan) => [
    { call: (_tools, _project, heard) => ({ name: "Write", arguments: { file_path: planFile("Claude Code", heard), content: plan } }) },
    { call: () => ({ name: "ExitPlanMode", arguments: {} }) },
    { text: "The plan is approved." },
  ],
}

/** Claude Code through the Agent SDK, launched by Mako's option builder; each prompt waits on the turn before it. */
const claude: Recorder = {
  model: { kind: "scripted", tools: CLAUDE_TOOLS },
  controls: {
    steer: "driven",
    rewind: { absent: "Claude Code 2.1.283's SDK rewinds files only (`rewindFiles`); its conversation rewind is the TUI's /rewind" },
    compact: "driven",
  },
  keeps: (file) => /\/projects\/[^/]+\/.+\.jsonl$/.test(file),
  async record(sandbox, scenario) {
    const steps = script(scenario, CLAUDE_TOOLS, sandbox.project)
    const model = await scriptedModel({ reply: steps.reply })
    const env = {
      ...sandbox.env, ...scenario.env, CLAUDE_CONFIG_DIR: join(sandbox.home, ".claude"),
      ANTHROPIC_BASE_URL: model.url, ANTHROPIC_API_KEY: "mako-decode-pair", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    }
    const conversationId = randomUUID()
    const { options } = await claudeSdkOptions(sandbox.project, {
      conversationId, modeId: claudeMode(scenario.turns[0]),
      mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
      accountLaunch: { env, account: { name: "default" }, selection: { kind: "unavailable" } },
    }, new ProviderLaunchTrace({ provider: "claude", conversation: "decode-pairs" }))
    const messages: JsonValue[] = []
    const prompts: Prompt[] = []
    let version: string | undefined
    let settled = () => {}
    let stopping: Turn | undefined
    let steering: { text: string; uuid: ReturnType<typeof randomUUID>; due: () => void } | undefined
    let conversation: Query | undefined
    async function* input(): AsyncGenerator<SDKUserMessage> {
      let mode = claudeMode(scenario.turns[0])
      for (const turn of scenario.turns) {
        stopping = turn.stop && turn
        const done = new Promise<void>((resolve) => { settled = resolve })
        // The first turn's mode is the launch's; the query exists for the ones after.
        if (claudeMode(turn) !== mode) await conversation?.setPermissionMode((mode = claudeMode(turn)))
        const attachments = await staged(sandbox.project, turn)
        prompts.push(turn.compact ? { at: messages.length } : prompted(messages.length, turn.prompt, attachments))
        // As Mako sends each: a compaction as the bare command, a prompt as content blocks.
        const content = turn.compact ? turn.prompt : await claudeInputContent(turn.prompt, attachments)
        yield { type: "user", message: { role: "user", content }, parent_tool_use_id: null }
        if (turn.steer) {
          const text = turn.steer
          const due = await Promise.race([new Promise<boolean>((resolve) => { steering = { text, uuid: randomUUID(), due: () => resolve(true) } }), done.then(() => false)])
          if (!due || !steering) throw new Error(`Claude Code ran no tool to steer ${JSON.stringify(text)} into`)
          // As Mako steers Claude: a message joining the running query, read at its next step.
          yield { type: "user", uuid: steering.uuid, priority: "now", message: { role: "user", content: text }, parent_tool_use_id: null }
        }
        await done
      }
    }
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), TURN_MS * scenario.turns.length)
    let results = 0
    try {
      try {
        conversation = query({
          prompt: input(),
          options: {
            ...options, abortController: abort,
            // A question is answered with each one's first option, keyed by its text as Mako answers it.
            canUseTool: async (name, toolInput) => {
              const asked = name === "AskUserQuestion" ? ClaudeQuestions.safeParse(toolInput).data : undefined
              if (!asked) return { behavior: "allow", updatedInput: toolInput }
              return { behavior: "allow", updatedInput: { ...toolInput, answers: Object.fromEntries(asked.questions.map((question) => [question.question, question.options[0]?.label ?? ""])) } }
            },
          },
        })
        for await (const message of conversation) {
          messages.push(z.json().parse(JSON.parse(JSON.stringify(message))))
          if (message.type === "system" && message.subtype === "init") version = message.claude_code_version
          // Claude Code runs a command it deems harmless without asking, so the stop follows the call, not the permission.
          const calling = message.type === "assistant" && message.message.content.some((block) => block.type === "tool_use")
          if (stopping && calling) {
            stopping = undefined
            const running = conversation
            setTimeout(() => void running.interrupt(), STOP_AFTER_MS)
          }
          if (steering && calling) setTimeout(steering.due, STOP_AFTER_MS)
          // Mako records a steer once Claude Code shows it took it.
          if (steering && claudeAcknowledged(message).has(steering.uuid)) {
            prompts.push({ at: messages.length, text: steering.text, steered: true })
            steering = undefined
          }
          if (message.type === "result") {
            results++
            settled()
          }
        }
      } catch (error) {
        // The input ends after the last result, and Claude Code exits non-zero when that turn failed.
        if (results < scenario.turns.length) throw error
      }
      if (abort.signal.aborted) throw new Error(`Claude Code did not finish ${scenario.name} within ${TURN_MS * scenario.turns.length / 1000}s`)
      if (!version) throw new Error("Claude Code reported no version")
      scripted("Claude Code", scenario, model.requests, steps)
      const file = (await storeReader("claude", sandbox.home).discover()).find((candidate) => candidate.path.endsWith(`${conversationId}.jsonl`))
      if (!file) throw new Error("Claude Code wrote no session to its store")
      return { version, recording: { harness: "claude", session: { settings: { model: null } }, native: { version, origin: "captured" }, messages, prompts }, store: file.path }
    } finally {
      clearTimeout(timer)
      await model.close()
    }
  },
}

function claudeMode(turn: Turn | undefined): "plan" | "default" {
  return turn?.plan ? "plan" : "default"
}

/** The harness asked the model once per step: no fewer, as a turn it never asked for; no more, as an unscripted request. */
function scripted(harness: string, scenario: Scenario, requests: Awaited<ReturnType<typeof scriptedModel>>["requests"], steps: Script): void {
  const listed = () => requests.map((request) => `${request.path}${request.conversation ? " (turn)" : ""}${request.unscripted ? " (unscripted)" : ""}`).join(", ")
  const unscripted = requests.filter((request) => request.unscripted).length
  if (unscripted) throw new Error(`${harness} asked the model ${unscripted} more times than ${scenario.name} has steps: ${listed()}`)
  if (!requests.some((request) => request.conversation)) throw new Error(`${harness} never asked the scripted model for the turn: ${listed()}`)
  if (steps.unheard.length) throw new Error(`${harness} never delivered what ${scenario.name}'s steps wait on: ${steps.unheard.join("; ")}`)
}

/** gpt-5.5 calls `exec_command` and `apply_patch` itself; the gpt-6 models reach them only from inside `exec`, Codex's code mode. */
const CODEX_MODEL = "gpt-5.5"

const CODEX_TOOLS: ToolVocabulary = {
  read: (path, lines) => ({
    name: "exec_command",
    arguments: { cmd: lines ? `sed -n '${lines.offset},${lines.offset + lines.limit - 1}p' ${path}` : `cat ${path}` },
  }),
  shell: (command) => ({ name: "exec_command", arguments: { cmd: command } }),
  viewImage: (path) => ({ name: "view_image", arguments: { path } }),
  edit: (path, from, to) => ({ name: "apply_patch", input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-${patchLine(path, from)}\n+${patchLine(path, from).replace(from, to)}\n*** End Patch\n` }),
  todos: { absent: `Codex 0.159.3 defines no plan tool (update_plan) for ${CODEX_MODEL} or any listed model (native-tools/codex-0.159.3.json)` },
  search: { absent: "Codex 0.159.3 defines no file search tool; its model searches through the shell (native-tools/codex-0.159.3.json)" },
  codeMode: { model: "gpt-6-sol", cell: (source) => ({ name: "exec", input: source }) },
  ask: (question) => ({ name: "request_user_input", arguments: { questions: [{ id: "release_day", ...question }] } }),
  // Codex takes a plan-mode answer's `<proposed_plan>` block as the turn's plan; no tool proposes it.
  plan: (plan) => [{ text: `<proposed_plan>\n${plan}\n</proposed_plan>` }],
}

/** The scenario's file line holding `text`, which a patch replaces whole. */
function patchLine(path: string, text: string): string {
  const scenario = SCENARIOS.find((candidate) => Object.entries(candidate.files).some(([name, body]) => path.endsWith(`/${name}`) && body.includes(text)))
  const line = scenario && Object.entries(scenario.files).find(([name]) => path.endsWith(`/${name}`))?.[1].split("\n").find((candidate) => candidate.includes(text))
  if (!line) throw new Error(`No scenario file at ${path} holds ${text}`)
  return line
}

/** Codex's app-server with Mako's thread config, its model sealed to the scripted one; every approval is accepted once. */
const codex: Recorder = {
  model: { kind: "scripted", tools: CODEX_TOOLS },
  controls: {
    steer: "driven",
    rewind: { absent: "Codex 0.159.3's app-server has no rollback; its generated protocol names none" },
    compact: "driven",
  },
  keeps: (file) => /\/sessions\/\d{4}\/\d\d\/\d\d\/rollout-[^/]+\.jsonl$/.test(file),
  async record(sandbox, scenario) {
    const executable = await resolveCodexExecutable()
    if (!executable) throw new Error("Codex is not installed")
    const version = /\d+(?:\.\d+)+/.exec((await run(executable, ["--version"])).stdout)?.[0]
    if (!version) throw new Error("Codex reported no version")
    const steps = script(scenario, CODEX_TOOLS, sandbox.project)
    const model = await scriptedModel({ reply: steps.reply })
    const codexHome = join(sandbox.home, ".codex")
    await mkdir(codexHome, { recursive: true })
    await writeFile(join(codexHome, "config.toml"), `openai_base_url = "${model.url}/v1"\nchatgpt_base_url = "${model.url}/backend-api"\n`)
    await writeFile(join(codexHome, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "mako-decode-pair" }))
    const child = spawn(executable, ["app-server"], { cwd: sandbox.project, env: { ...sandbox.env, ...scenario.env, CODEX_HOME: codexHome }, stdio: ["pipe", "pipe", "pipe"] })
    const messages: JsonValue[] = []
    const prompts: Prompt[] = []
    let turnDone = () => {}
    let stopTurn: (() => void) | undefined
    let rollout: { thread: string; calls: CodexRolloutCalls } | undefined
    const peer = rpcPeer(child, {
      jsonrpc: false,
      timeoutMs: TURN_MS,
      refusal: "Mako's decode-pairs client does not answer this",
      // As Mako's capture records them: notifications, server requests and the answers they got.
      received: (message) => {
        if (!message.method) return
        if (message.id !== undefined) return void messages.push({ request: message.method, id: message.id, params: z.json().parse(message.params ?? {}) })
        const params = z.record(z.string(), z.json()).parse(message.params ?? {})
        // As Mako's driver reads the rollout (`codex-app-protocol.ts`).
        if (rollout && codexRolloutDue(message.method, params, rollout.thread)) {
          const calls = rollout.calls.read()
          if (calls.length) messages.push({ rollout: calls })
        }
        messages.push({ method: message.method, params })
        if (message.method === "turn/completed") turnDone()
        if (message.method === "item/started" && CodexToolStarted.safeParse(message.params).success) {
          const stopping = stopTurn
          stopTurn = undefined
          if (stopping) setTimeout(stopping, STOP_AFTER_MS)
        }
      },
      answer: (message) => {
        const result = codexAnswer(message)
        if (result && message.id !== undefined) messages.push({ answered: message.id, result })
        return result
      },
    })
    try {
      await peer.call("initialize", { clientInfo: { name: "mako-decode-pairs", version: "0" }, capabilities: CODEX_CLIENT_CAPABILITIES })
      peer.notify("initialized")
      const codeMode = scenario.needs?.includes("codeMode") && !("absent" in CODEX_TOOLS.codeMode) ? CODEX_TOOLS.codeMode.model : undefined
      const thread = z.object({ thread: z.object({ id: z.string(), path: z.string().nullish() }) }).parse(await peer.call("thread/start", { cwd: sandbox.project, model: codeMode ?? CODEX_MODEL, config: codexInteractiveConfig() }))
      if (thread.thread.path) rollout = { thread: thread.thread.id, calls: new CodexRolloutCalls(thread.thread.path) }
      const threadModel = codeMode ?? CODEX_MODEL
      const planning = scenario.turns.some((turn) => turn.plan)
      for (const turn of scenario.turns) {
        const done = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Codex did not finish a ${scenario.name} turn within ${TURN_MS / 1000}s`)), TURN_MS)
          turnDone = () => (clearTimeout(timer), resolve())
        })
        if (turn.compact) {
          await peer.call("thread/compact/start", { threadId: thread.thread.id })
          await done
          continue
        }
        // Mako sends the plan setting on every turn of a session that has one, `default` included.
        const mode = planning ? codexCollaborationMode({ model: threadModel, options: { plan: turn.plan === true } }, threadModel) : {}
        const attachments = await staged(sandbox.project, turn)
        prompts.push(prompted(messages.length, turn.prompt, attachments))
        const started = z.object({ turn: z.object({ id: z.string() }) }).parse(await peer.call("turn/start", { threadId: thread.thread.id, input: z.array(z.json()).parse(codexInput(turn.prompt, attachments)), ...mode }))
        if (turn.stop) stopTurn = () => void peer.call("turn/interrupt", { threadId: thread.thread.id, turnId: started.turn.id }).catch(() => undefined)
        const text = turn.steer
        let steered: Promise<void> | undefined
        // As Mako steers Codex (`codexAppSteer`).
        if (text) stopTurn = () => {
          steered = peer.call("turn/steer", { threadId: thread.thread.id, expectedTurnId: started.turn.id, clientUserMessageId: randomUUID(), input: [{ type: "text", text, text_elements: [] }] })
            .then(() => void prompts.push({ at: messages.length, text, steered: true }))
          steered.catch(() => undefined)
        }
        await done
        if (text && !steered) throw new Error(`Codex ran no tool to steer ${JSON.stringify(text)} into`)
        await steered
      }
      scripted("Codex", scenario, model.requests, steps)
      const file = (await storeReader("codex", sandbox.home).discover()).find((candidate) => candidate.path.includes(thread.thread.id))
      if (!file) throw new Error("Codex wrote no session to its store")
      return { version, recording: { harness: "codex", session: { threadId: thread.thread.id }, native: { version, origin: "captured" }, messages, prompts }, store: file.path }
    } finally {
      peer.close()
      await stop(child)
      await model.close()
    }
  },
}

const OPENCODE_TOOLS: ToolVocabulary = {
  read: (path, lines) => ({ name: "read", arguments: { path, ...lines } }),
  shell: (command) => ({ name: "shell", arguments: { command } }),
  edit: (path, from, to) => ({ name: "edit", arguments: { path, oldString: from, newString: to } }),
  viewImage: (path) => ({ name: "read", arguments: { path } }),
  todos: { absent: "OpenCode 2.0.1 defines no todo tool for its agents (native-tools/opencode-2.0.1.json)" },
  search: (pattern) => ({ name: "grep", arguments: { pattern } }),
  codeMode: { absent: "OpenCode 2.0.1 defines no tool that runs code calling its other tools (native-tools/opencode-2.0.1.json)" },
  ask: (question) => ({ name: "question", arguments: { questions: [question] } }),
  // The plan agent's closing answer is its plan (`openCodePlan`); no tool proposes it.
  plan: (plan) => [{ text: plan }],
}

const OPENCODE_TURN_ENDS = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

/**
 * OpenCode's native API as Mako starts it, in Mako's default mode, on an
 * Anthropic model. Like Mako's driver it follows the event stream from
 * before the session exists and records from the session on; each
 * permission is granted once.
 */
const opencode: Recorder = {
  model: { kind: "scripted", tools: OPENCODE_TOOLS },
  controls: {
    steer: "driven",
    rewind: "driven",
    compact: "driven",
  },
  keeps: (file) => /\/opencode\/opencode(?:-next)?\.db$/.test(file),
  async record(sandbox, scenario) {
    const installation = await resolveOpenCodeInstallation(process.env)
    const steps = script(scenario, OPENCODE_TOOLS, sandbox.project)
    const model = await scriptedModel({ reply: steps.reply })
    const launchAccess = openCodeLaunchAccess(OPENCODE_DEFAULT_MODE)
    const env: NodeJS.ProcessEnv = {
      ...sandbox.env, ...scenario.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { anthropic: { options: { baseURL: `${model.url}/v1`, apiKey: "mako-decode-pair" } } } }),
      OPENCODE_DISABLE_MODELS_FETCH: "1",
      OPENCODE_DISABLE_AUTOUPDATE: "1",
    }
    configureOpenCodePermissions(env, launchAccess)
    const api = await startOpenCodeApi({ command: installation.command, cwd: sandbox.project, env, conversationId: randomUUID(), trace: new ProviderLaunchTrace({ provider: "opencode", conversation: "decode-pairs" }) })
    const stream = new AbortController()
    const messages: JsonValue[] = []
    const prompts: Prompt[] = []
    let root: string | undefined
    let turnEnded = () => {}
    let reverted = () => {}
    let stopping: Turn | undefined
    let steering: (() => void) | undefined
    try {
      const events = api.client.event.subscribe({ signal: stream.signal })[Symbol.asyncIterator]()
      const hello = await events.next()
      if (hello.done || hello.value.type !== "server.connected") throw new Error("OpenCode's event stream did not open")
      void (async () => {
        for (let next = await events.next(); !next.done; next = await events.next()) {
          const event = next.value
          if (!root) continue
          messages.push(z.json().parse(JSON.parse(JSON.stringify(event))))
          if (event.type === "permission.asked" && event.data.sessionID === root)
            void api.client.permission.reply({ sessionID: root, requestID: event.data.id, reply: "once" })
          if (event.type === "form.created" && event.data.form.sessionID === root) {
            const form = OpenCodeForm.parse(event.data.form)
            void api.client.form.reply({ sessionID: root, formID: form.id, answer: Object.fromEntries(form.fields.map((field) => [field.key, field.options?.[0]?.value ?? ""])) })
          }
          // A compaction is an execution too, and ends after `session.compaction.ended`.
          if (OPENCODE_TURN_ENDS.has(event.type) && OpenCodeSessionEvent.safeParse(event).data?.data.sessionID === root) turnEnded()
          if (event.type === "session.revert.committed" && event.data.sessionID === root) reverted()
          if (event.type === "session.tool.called" && stopping && event.data.sessionID === root) {
            const session = root
            stopping = undefined
            setTimeout(() => void api.client.session.interrupt({ sessionID: session }).catch(() => undefined), STOP_AFTER_MS)
          }
          if (event.type === "session.tool.called" && steering && event.data.sessionID === root) {
            setTimeout(steering, STOP_AFTER_MS)
            steering = undefined
          }
        }
      })().catch(() => undefined)
      const location = { directory: sandbox.project }
      await api.client.plugin.awaitActivation({ location })
      const models = await api.client.model.list({ location })
      const chosen = models.data.find((entry) => entry.providerID === "anthropic" && entry.enabled && entry.status !== "deprecated")
      if (!chosen) throw new Error("OpenCode offers no Anthropic model with the pair's key")
      const agent = openCodeAgentForMode(OPENCODE_DEFAULT_MODE, launchAccess)
      const session = await api.client.session.create({ location, agent, model: { id: chosen.id, providerID: "anthropic" } })
      root = session.id
      let current = agent
      /** Each prompt's message id, which OpenCode's revert names. */
      const sent: string[] = []
      for (const turn of scenario.turns) {
        if (turn.rewind !== undefined) {
          // As a person reverts in OpenCode: stage the revert to the turn's prompt, then commit it.
          const messageID = sent[turn.rewind]
          if (!messageID) throw new Error(`OpenCode has no turn ${turn.rewind} to revert to`)
          // The next prompt goes after the commit on the wire, as it does for a person.
          const committed = new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("OpenCode did not report the committed revert")), TURN_MS)
            reverted = () => (clearTimeout(timer), resolve())
          })
          await api.client.session.revert.stage({ sessionID: root, messageID })
          await api.client.session.revert.commit({ sessionID: root })
          await committed
          sent.length = turn.rewind
          continue
        }
        stopping = turn.stop && turn
        const ended = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`OpenCode did not finish a ${scenario.name} turn within ${TURN_MS / 1000}s`)), TURN_MS)
          turnEnded = () => (clearTimeout(timer), resolve())
        })
        const wanted = turn.plan ? OPENCODE_PLAN_AGENT : agent
        if (wanted !== current) await api.client.session.switchAgent({ sessionID: root, agent: (current = wanted) })
        // A failed turn is the prompt's error; the next prompt goes on, as it does in Mako.
        const text = turn.steer
        const session = root
        let steered: Promise<void> | undefined
        // As Mako steers OpenCode: a prompt delivered as a steer, read at the running turn's next step.
        if (text) steering = () => {
          steered = api.client.session.prompt({ sessionID: session, id: openCodeMessageId(), text, delivery: "steer" })
            .then(() => void prompts.push({ at: messages.length, text, steered: true }))
          steered.catch(() => undefined)
        }
        if (turn.compact) await api.client.session.compact({ sessionID: root, id: openCodeMessageId() }).catch(() => undefined)
        else {
          const id = openCodeMessageId()
          const attachments = await staged(sandbox.project, turn)
          prompts.push({ ...prompted(messages.length, turn.prompt, attachments), run: id })
          sent.push(id)
          await api.client.session.prompt({ sessionID: root, id, text: turn.prompt, files: promptFiles(attachments) }).catch(() => undefined)
        }
        await ended
        if (text && !steered) throw new Error(`OpenCode ran no tool to steer ${JSON.stringify(text)} into`)
        await steered
      }
      scripted("OpenCode", scenario, model.requests, steps)
      const version = api.health.version
      // Closed first, so the store is whole when it is read.
      stream.abort()
      await api.close()
      const file = (await storeReader("opencode", sandbox.home).discover()).find((candidate) => candidate.path.endsWith(encodeURIComponent(session.id)))
      if (!file) throw new Error("OpenCode wrote no session to its store")
      return { version, recording: { harness: "opencode", session: { root: session.id, cwd: sandbox.project, launchAccess, contextSize: null }, native: { version, origin: "captured" }, messages, prompts }, store: file.path }
    } finally {
      stream.abort()
      await api.close()
      await model.close()
    }
  },
}

const DevinSteps = z.object({ steps: z.array(z.object({ stepId: z.string(), kind: z.string(), userMessageId: z.string().optional() }).loose()) }).loose()
const DevinReverted = z.object({ outcomes: z.array(z.json()) }).loose()

/**
 * As Devin.app reverts a step, which Devin 3000.10.23 serves only to a client
 * advertising `cognition.ai/revert`: the session's prompt steps, then the
 * target's. Devin rewinds the session in place and says `historyRewound`.
 */
async function devinRewind(call: AcpCall, sessionId: string, target: number): Promise<void> {
  const { steps } = DevinSteps.parse(await call("_cognition.ai/revert/listSteps", { sessionId }))
  const step = steps.filter((candidate) => candidate.kind === "prompt")[target]
  if (!step) throw new Error(`Devin lists no prompt step ${target}`)
  const reply = DevinReverted.safeParse(await call("_cognition.ai/revert/execute", { sessionId, stepId: step.stepId }))
  if (!reply.success || reply.data.outcomes.length) throw new Error(`Devin did not revert to step ${target} cleanly: ${JSON.stringify(reply.data ?? null)?.slice(0, 300)}`)
}

/**
 * Each prompt's Devin id, which `historyRewound` names: the step that
 * `stepsUpdated` lists first after the prompt went out.
 */
function devinPromptRuns(wire: Pick<Recording, "messages" | "prompts">): void {
  const seen = new Set<string>()
  const prompts = (wire.prompts ?? []).filter((prompt) => !prompt.steered && prompt.text !== undefined)
  wire.messages.forEach((message, index) => {
    const update = z.object({ method: z.literal("_cognition.ai/revert/stepsUpdated"), params: DevinSteps }).safeParse(message)
    if (!update.success) return
    for (const { kind, userMessageId } of update.data.params.steps) {
      if (kind !== "prompt" || !userMessageId || seen.has(userMessageId)) continue
      seen.add(userMessageId)
      const prompt = prompts.find((candidate) => candidate.run === undefined && candidate.at <= index)
      if (prompt) prompt.run = userMessageId
    }
  })
}

/** The person's Devin sign-in, which a pair's sandbox links, as Mako's account profiles do (`linkDataHome`), and never copies. */
const DEVIN_CREDENTIALS = join(process.env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "devin", "credentials.toml")

/**
 * Devin over ACP, as Mako's ACP source launches it, in Mako's default mode.
 * The sandbox's data home links the person's `credentials.toml`, so Devin
 * signs in as them and writes its `sessions.db` in the sandbox, not in
 * their store. Its model answers for real, which spends usage.
 */
const devin: Recorder = {
  model: {
    kind: "own",
    why: "Devin's model is behind Windsurf's API server, whose protocol the scripted model doesn't speak",
    lacks: { codeMode: "Devin 3000.10.23 names no tool that runs code calling its other tools; its model ran the code-mode prompt as one chained `exec`" },
  },
  controls: {
    steer: "driven",
    // Mako's conversation process doesn't advertise `cognition.ai/revert` (only its fork process does, `devin/fork.ts`); the pair turns it on to read what a revert writes.
    rewind: "driven",
    compact: "driven",
  },
  keeps: (file) => file.endsWith("/devin/cli/sessions.db"),
  secrets: async () => credentialValues(await readFile(DEVIN_CREDENTIALS, "utf8")),
  async record(sandbox, scenario) {
    if (!existsSync(DEVIN_CREDENTIALS)) throw new Error("Devin isn't signed in; run `devin` once and sign in")
    const data = sandbox.env.XDG_DATA_HOME
    if (!data) throw new Error("The sandbox has no data home")
    await mkdir(join(data, "devin"), { recursive: true })
    await symlink(DEVIN_CREDENTIALS, join(data, "devin", "credentials.toml"))
    const env: NodeJS.ProcessEnv = { ...sandbox.env, ...scenario.env }
    const launch = await devinAcpSource.launch({ appPath: process.cwd(), execPath: process.execPath, cwd: sandbox.project, env, access: devinAcpSource.access?.default })
    if (!launch) throw new Error("Devin's ACP source declined to launch")
    launch.configureEnvironment(env)
    const version = await versionOf(launch.command)
    const wire = await acpSession({
      command: launch.command, args: launch.args, env, cwd: sandbox.project,
      mode: devinAcpSource.access?.native?.edits, source: devinAcpSource, rewind: devinRewind,
      meta: scenario.turns.some((turn) => turn.rewind !== undefined) ? { "cognition.ai/revert": true } : undefined,
    }, scenario.turns)
    devinPromptRuns(wire)
    const [file] = await storeReader("devin", sandbox.home).discover()
    if (!file) throw new Error("Devin wrote no session to its store")
    return { version, recording: { harness: "devin", session: { settings: { model: null } }, native: { version, origin: "captured" }, ...wire }, store: file.path }
  },
}

/** Cursor's own agent model, which follows the scenarios' prompts and costs little. */
const CURSOR_MODEL = "composer-2.5"
const CURSOR_CHILD = join(process.cwd(), "node_modules", ".tmp", "decode-pairs", "cursor-child.js")

/** The SDK child as Mako ships it, bundled privately: the app's own build belongs to whoever runs the app. */
async function cursorChild(): Promise<string> {
  await build({
    entryPoints: ["electron/providers/cursor/sdk/child.ts"], outfile: CURSOR_CHILD,
    bundle: true, platform: "node", format: "esm", packages: "external", target: "node22", logLevel: "warning",
  })
  return CURSOR_CHILD
}

/** The key Mako's resolver would hand a child (`CursorSdkAuth`), minus the one Mako keeps encrypted, which needs Electron. */
async function cursorKey(): Promise<string> {
  const key = process.env.CURSOR_API_KEY || await readCursorCliApiKey()
  if (!key) throw new Error("Cursor isn't signed in; set CURSOR_API_KEY or run `cursor-agent login`")
  return key
}

/** A turn's attachments as `promptImages` in the Cursor driver sends them; the scenarios attach only images. */
function cursorImages(attachments: readonly PromptAttachment[]): SdkImage[] {
  return attachments.map(({ name, data, mimeType }) => {
    if (!data || !mimeType.startsWith("image/")) throw new Error(`decode-pairs sends Cursor only images, not ${name}`)
    return { data, mimeType }
  })
}

/**
 * Cursor's SDK child as Mako's driver runs it, from a private bundle, with
 * the sandbox as its home, so the agent's `store.db` lands under the
 * sandbox's `.mako/cursor-sdk`. The child gets the person's key in its
 * environment, as Mako's children do. Its model answers for real, which
 * spends usage.
 */
const cursor: Recorder = {
  model: {
    kind: "own",
    why: "Cursor's model is behind Cursor's own service, which the scripted model can't stand in for",
    lacks: {
      codeMode: "Cursor SDK 1.0.31 reports no tool that runs code calling its other tools (native-tools/cursor-1.0.31.json)",
      ask: "Cursor SDK 1.0.31 declines every `askQuestion` itself in local runs (\"Interactive questions are not supported in local SDK runs\"), so Mako declares questions unavailable",
    },
  },
  controls: {
    steer: "driven",
    rewind: { absent: "Cursor SDK 1.0.31 has no rewind; Mako forks by writing the conversation into a new agent" },
    compact: { absent: "Cursor summarizes on its server when the context fills; its protocol's summarize action is never sent by SDK 1.0.31, which offers no way to ask" },
  },
  // The agent's root is named in the SDK's `index.db`, not in its own store.
  keeps: (file) => /\/\.mako\/cursor-sdk\/(index\.db|agents\/agent-[0-9a-f]+\/store\.db)$/.test(file),
  storeFolder: (store) => dirname(dirname(dirname(store))),
  secrets: async () => [await cursorKey()],
  async record(sandbox, scenario) {
    const entry = await cursorChild()
    const messages: JsonValue[] = []
    const prompts: Prompt[] = []
    let turnDone = (_turn: string) => {}
    let toolStarted: (() => void) | undefined
    const client = new CursorSdkClient({
      owner: "mako-decode-pairs", cwd: sandbox.project, entry, execPath: process.execPath,
      env: { ...sandbox.env, ...scenario.env, CURSOR_API_KEY: await cursorKey() },
      onEvent: (event: SdkEvent) => {
        if (event.event === "log" || event.event === "login-url") return
        messages.push(z.json().parse(event))
        if (event.event === "result") turnDone(event.turn)
        if (event.event === "message" && event.message.type === "tool_call" && event.message.status === "running" && toolStarted) {
          const started = toolStarted
          toolStarted = undefined
          setTimeout(started, STOP_AFTER_MS)
        }
      },
    })
    try {
      const { sdkVersion } = await client.hello()
      const catalog = normalizeCursorSdkModels((await client.request("models", undefined)).models)
      const model = cursorSdkSelection({ model: CURSOR_MODEL }, catalog.models)?.selection
      if (!model) throw new Error(`Cursor doesn't offer ${CURSOR_MODEL} to this account`)
      const opened = await client.request("open", { cwd: sandbox.project, stateRoot: cursorSdkStateRoot(sandbox.env, sandbox.home), agentId: randomUUID(), create: true, model })
      for (const turn of scenario.turns) {
        const id = randomUUID()
        const done = new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(`Cursor did not finish a ${scenario.name} turn within ${TURN_MS / 1000}s`)), TURN_MS)
          turnDone = (ended) => {
            if (ended !== id) return
            clearTimeout(timer)
            resolve()
          }
        })
        const attachments = await staged(sandbox.project, turn)
        prompts.push(prompted(messages.length, turn.prompt, attachments))
        const images = cursorImages(attachments)
        if (turn.stop) toolStarted = () => void client.request("cancel", undefined).catch(() => undefined)
        const text = turn.steer
        let steered: Promise<void> | undefined
        // As Mako steers Cursor (the driver's `steering.steer`).
        if (text) toolStarted = () => {
          steered = client.request("steer", { text }).then(({ outcome }) => {
            if (outcome !== "complete_delivered") throw new Error(`Cursor didn't take the steer: ${outcome}`)
            prompts.push({ at: messages.length, text, steered: true })
          })
          steered.catch(() => undefined)
        }
        await client.request("send", { turn: id, text: turn.prompt, images: images.length ? images : undefined, model, plan: turn.plan })
        await done
        if (text && !steered) throw new Error(`Cursor ran no tool to steer ${JSON.stringify(text)} into`)
        await steered
      }
      const store = cursorSdkStorePath(cursorSdkStateRoot(sandbox.env, sandbox.home), opened.agentId)
      if (!existsSync(store)) throw new Error("Cursor wrote no session to its store")
      return { version: sdkVersion, recording: { harness: "cursor", session: { settings: { model: model.id } }, native: { version: sdkVersion, origin: "captured" }, messages, prompts }, store }
    } finally {
      await client.close().catch(() => client.kill())
    }
  },
}

/** Every quoted value in a TOML credentials file that could be a secret: long, and not a URL. */
function credentialValues(toml: string): string[] {
  return [...toml.matchAll(/^\s*[\w-]+\s*=\s*"([^"]{16,})"\s*$/gm)].flatMap(([, value]) => value && !/^https?:/.test(value) ? [value] : [])
}

/** Fails, without saying what matched, when a recording or the store it names holds one of `secrets`. */
async function credentialFree(pair: RecordedPair, secrets: readonly string[]): Promise<void> {
  if (!secrets.length) return
  const store = pair.store.replace(/#.*$/, "")
  const texts = [JSON.stringify(pair.recording.messages), ...await Promise.all([store, `${store}-wal`].map((file) => readFile(file, "latin1").catch(() => "")))]
  if (texts.some((text) => secrets.some((secret) => text.includes(secret))))
    throw new Error(`The ${pair.recording.harness} recording or its store holds a credential the run had; nothing was printed or kept`)
}

/** What a person does with each Codex request: accepts the approval, picks each question's first option. */
function codexAnswer({ method, params }: RpcMessage): JsonObject | undefined {
  if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") return { decision: "accept" }
  if (method !== "item/tool/requestUserInput") return undefined
  const { questions } = CodexUserInput.parse(params)
  return { answers: Object.fromEntries(questions.map((question) => [question.id, { answers: question.options?.slice(0, 1).map((option) => option.label) ?? [] }])) }
}

const OpenCodeSessionEvent = z.object({ data: z.object({ sessionID: z.string() }).loose() }).loose()

/** A Codex item that is a tool at work, not the conversation's words. */
const CodexToolStarted = z.object({ item: z.object({ type: z.enum(["commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall"]) }).loose() }).loose()

/** An ACP update that starts a tool. */
const AcpToolStarted = z.object({ update: z.object({ sessionUpdate: z.literal("tool_call") }).loose() }).loose()

const RECORDERS = new Map<string, Recorder>([["claude", claude], ["codex", codex], ["cursor", cursor], ["devin", devin], ["grok", grok], ["opencode", opencode]])

async function versionOf(command: string): Promise<string> {
  const executable = resolveExecutable(command, process.env)
  if (!executable) throw new Error(`${command} is not installed`)
  const version = /\d+(?:\.\d+)+/.exec((await run(executable, ["--version"])).stdout)?.[0]
  if (!version) throw new Error(`${command} reported no version`)
  return version
}

const Permission = z.object({ options: z.array(z.object({ optionId: z.string(), kind: z.string().optional() }).loose()) }).loose()
const PromptReply = z.object({ stopReason: z.enum(["end_turn", "max_tokens", "max_turn_requests", "refusal", "cancelled"]) })
const AcpInitialized = z.object({ agentCapabilities: z.object({ promptCapabilities: z.object({ image: z.boolean().optional() }).loose().nullish() }).loose().nullish() }).loose()
const AcpNewSession = z.object({ sessionId: z.string(), modes: z.object({ currentModeId: z.string() }).loose().nullish() }).loose()
const GrokQuestions = z.object({ questions: z.array(z.object({ question: z.string(), options: z.array(z.object({ label: z.string() }).loose()) }).loose()) }).loose()
const ClaudeQuestions = z.object({ questions: z.array(z.object({ question: z.string(), options: z.array(z.object({ label: z.string() }).loose()) }).loose()) }).loose()
const CodexUserInput = z.object({ questions: z.array(z.object({ id: z.string(), options: z.array(z.object({ label: z.string() }).loose()).nullish() }).loose()) }).loose()
const OpenCodeForm = z.object({ id: z.string(), fields: z.array(z.object({ key: z.string(), options: z.array(z.object({ value: z.string() }).loose()).optional() }).loose()) }).loose()

/** An ACP form's fields each given its first choice: an enum's first value, a titled option's, a multi-select's first, `true`. */
const ElicitationProperty = z.object({
  type: z.string().optional(),
  enum: z.array(z.string()).nullish(),
  oneOf: z.array(z.object({ const: z.string() }).loose()).nullish(),
  items: z.object({ enum: z.array(z.string()).nullish(), anyOf: z.array(z.object({ const: z.string() }).loose()).nullish() }).loose().nullish(),
}).loose()
const ElicitationForm = z.object({ requestedSchema: z.object({ properties: z.record(z.string(), ElicitationProperty) }).loose() }).loose()

function elicitationAnswer(params: RpcMessage["params"]): JsonObject {
  const { properties } = ElicitationForm.parse(params).requestedSchema
  return Object.fromEntries(Object.entries(properties).map(([key, property]): [string, JsonValue] => {
    if (property.type === "boolean") return [key, true]
    if (property.type === "array") return [key, [property.items?.enum?.[0] ?? property.items?.anyOf?.[0]?.const ?? ""]]
    return [key, property.enum?.[0] ?? property.oneOf?.[0]?.const ?? ""]
  }))
}

type AcpCall = (method: string, params: JsonObject) => Promise<RpcMessage["result"]>

const ATTACHMENT_TYPES = new Map([[".png", "image/png"]])

/** A turn's attachments as Mako stages one: the file's bytes beside its path. */
async function staged(project: string, turn: Turn): Promise<PromptAttachment[]> {
  return Promise.all((turn.attachments ?? []).map(async (file) => {
    const mimeType = ATTACHMENT_TYPES.get(extname(file))
    if (!mimeType) throw new Error(`decode-pairs has no type for the attachment ${file}`)
    const path = join(project, file)
    const bytes = await readFile(path)
    return { name: basename(file), mimeType, size: bytes.length, data: bytes.toString("base64"), path }
  }))
}

/** A prompt as Mako drew it: its text, and each attachment's name and type. */
function prompted(at: number, text: string, attachments: readonly PromptAttachment[]): Prompt {
  if (!attachments.length) return { at, text }
  return { at, text, attachments: attachments.map(({ name, mimeType }): PromptFile => ({ name, mimeType })) }
}

/**
 * Prompts over ACP in one session, every message the agent sends recorded as
 * Mako's ACP client records it: `{ method, params }`, or `{ request, params }`
 * for one it waits on. Permission is granted once, as a person allowing the
 * call would. A steer goes as the source declares Mako steers; a rewind, which
 * Mako doesn't drive, as `rewind` does it.
 */
async function acpSession(
  input: {
    command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string; mode?: string; source: ProviderAcpSource
    rewind?: (call: AcpCall, sessionId: string, target: number) => Promise<void>
    /** Client capabilities beyond Mako's, which a scenario needs and Mako doesn't advertise. */
    meta?: JsonObject
  },
  turns: readonly Turn[],
): Promise<Pick<Recording, "messages" | "prompts">> {
  const executable = resolveExecutable(input.command, input.env)
  if (!executable) throw new Error(`${input.command} is not installed`)
  const child = spawn(executable, input.args, { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] })
  const messages: JsonValue[] = []
  const sent: Prompt[] = []
  const params = (message: RpcMessage): JsonObject => z.record(z.string(), z.json()).parse(message.params ?? {})
  const updates = await acpSessionNotificationSchema()
  let stopTurn: (() => void) | undefined
  let steered: Promise<void> | undefined
  let compaction: AcpCompaction | undefined
  const peer = rpcPeer(child, {
    jsonrpc: true,
    timeoutMs: TURN_MS,
    refusal: "Mako's decode-pairs client does not answer this",
    received: (message) => {
      if (!message.method) return
      messages.push(message.id === undefined ? { method: message.method, params: params(message) } : { request: message.method, params: params(message) })
      if (message.method === "session/update" && AcpToolStarted.safeParse(message.params).success) {
        const stopping = stopTurn
        stopTurn = undefined
        if (stopping) setTimeout(stopping, STOP_AFTER_MS)
      }
      if (!compaction || message.id !== undefined) return
      // Settled as Mako's host settles it: by the source's own observer, or by the harness's decoded notice.
      if (message.method === "session/update") {
        const parsed = updates?.safeParse(message.params)
        if (!parsed?.success) return
        // SAFETY: the SDK's own `session/update` schema accepted it.
        const notification = parsed.data as SessionNotification
        compaction.observe(notification.update)
        return
      }
      const decoded = input.source.decodeNotification?.(message.method, params(message))
      const outcome = decoded?.notices && compactionOutcome(decoded.notices, decoded.usage)
      if (outcome) compaction.confirm(outcome)
    },
    answer: (message): JsonObject | undefined => {
      switch (message.method) {
        case "session/request_permission": {
          const { options } = Permission.parse(message.params)
          const option = options.find((candidate) => candidate.kind === "allow_once") ?? options[0]
          return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined
        }
        // Grok's question, plan and trust requests, answered as Mako answers them: each question's first option, keyed by its text; the plan approved; the throwaway project trusted.
        case "_x.ai/ask_user_question": {
          const { questions } = GrokQuestions.parse(message.params)
          return { outcome: "accepted", answers: Object.fromEntries(questions.map((question) => [question.question, question.options[0]?.label ?? ""])), annotations: {} }
        }
        case "_x.ai/exit_plan_mode":
          return { outcome: "approved" }
        case "_x.ai/folder_trust/request":
          return { outcome: "trust" }
        case "elicitation/create":
          return { action: "accept", content: elicitationAnswer(message.params) }
        default:
          return undefined
      }
    },
  })
  try {
    const capabilities = z.record(z.string(), z.json()).parse(acpClientCapabilities(input.source))
    if (input.meta) capabilities._meta = { ...z.record(z.string(), z.json()).parse(capabilities._meta ?? {}), ...input.meta }
    const initialized = AcpInitialized.parse(await peer.call("initialize", { protocolVersion: 1, clientCapabilities: capabilities }))
    // As Mako's ACP client reads them (`acp.ts`), with what a source declares its agent reads unadvertised.
    const advertised = initialized.agentCapabilities?.promptCapabilities ?? {}
    const reads = input.source.readsUnadvertised?.image ? { ...advertised, image: true } : advertised
    const session = AcpNewSession.parse(await peer.call("session/new", { cwd: input.cwd, mcpServers: [] }))
    if (input.mode) await peer.call("session/set_mode", { sessionId: session.sessionId, modeId: input.mode })
    const own = input.mode ?? session.modes?.currentModeId
    let mode = own
    const prompt = (text: string, attachments: readonly PromptAttachment[] = []) =>
      peer.call("session/prompt", { sessionId: session.sessionId, prompt: z.array(z.json()).parse(acpPromptBlocks(text, attachments, reads)) })
    const steer = async (text: string) => {
      const steering = input.source.steering
      if (steering.kind !== "supported") throw new Error(`${input.command} can't be steered: ${steering.reason}`)
      const { wire } = steering
      if (wire === "concurrent-prompt" || wire === "interrupting-prompt") void prompt(text).catch(() => undefined)
      else {
        const reply = await peer.call(wire.extension, { sessionId: session.sessionId, text })
        if (!wire.taken.safeParse(reply).success) throw new Error(`${input.command} did not take the steered message: ${JSON.stringify(reply)?.slice(0, 300)}`)
      }
      sent.push({ at: messages.length, text, steered: true })
    }
    for (const turn of turns) {
      if (turn.rewind !== undefined) {
        if (!input.rewind) throw new Error(`decode-pairs doesn't rewind ${input.command}`)
        await input.rewind(peer.call, session.sessionId, turn.rewind)
        continue
      }
      const wanted = turn.plan ? "plan" : own
      if (wanted && wanted !== mode) await peer.call("session/set_mode", { sessionId: session.sessionId, modeId: (mode = wanted) })
      const attachments = await staged(input.cwd, turn)
      sent.push(turn.compact ? { at: messages.length } : prompted(messages.length, turn.prompt, attachments))
      if (turn.stop) stopTurn = () => peer.notify("session/cancel", { sessionId: session.sessionId })
      const text = turn.steer
      if (text) stopTurn = () => {
        steered = steer(text)
        steered.catch(() => undefined)
      }
      const spec = input.source.compaction
      if (turn.compact && spec.kind === "supported") {
        // Devin 3000.10.23 answers /compact before compacting; a prompt sent before it settles cancels it.
        const settled = await new Promise<LiveActionResult>((resolve) => {
          const operation = new AcpCompaction(spec, (result) => { if (result.kind !== "uncertain") resolve(result) })
          compaction = operation
          operation.start(async () => PromptReply.parse(await prompt(spec.command)))
        })
        compaction?.dispose()
        compaction = undefined
        if (settled.kind !== "completed") throw new Error(`${input.command}'s compaction ended ${settled.kind}: ${"reason" in settled ? settled.reason : ""}`)
        continue
      }
      // A failed turn is the prompt's error; the next prompt goes on, as it does in Mako.
      await prompt(turn.prompt, attachments).catch(() => undefined)
      if (text && !steered) throw new Error(`${input.command} ran no tool to steer ${JSON.stringify(text)} into`)
      await steered
      steered = undefined
    }
    return { messages, prompts: sent }
  } finally {
    peer.close()
    await stop(child)
  }
}

/* ------------------------------------------------------------------ kept */

type Replacement = readonly [from: string, to: string]

/** The sandbox's paths, plain, URL-encoded or dash-encoded, each with what stands for it under `PAIR_ROOT`. */
function rootReplacements(sandbox: Sandbox): Replacement[] {
  const roots = [sandbox.root, sandbox.root.replace(/^\/private/, "")]
  return roots.flatMap((root): Replacement[] => [[root, PAIR_ROOT], [encodeURIComponent(root), encodeURIComponent(PAIR_ROOT)], [root.replaceAll("/", "-"), PAIR_ROOT.replaceAll("/", "-")]])
}

function rootedAt(replacements: readonly Replacement[]): (text: string) => string {
  return (text) => replacements.reduce((scrubbed, [from, to]) => scrubbed.replaceAll(from, to), text)
}

/** `rootedAt` for JSON Lines, also across the fragments a harness streamed a path in (`scrubJsonLines`). */
function linesRootedAt(replacements: readonly Replacement[]): (text: string) => string {
  const substitutions = rootSubstitutions(replacements)
  const scrub = rootedAt(replacements)
  return (text) => scrubJsonLines(scrub(text), substitutions)
}

function rootSubstitutions(replacements: readonly Replacement[]): Substitution[] {
  return replacements.map(([from, to]) => literally(from, to))
}

async function keep(harness: string, recorder: Recorder, scenario: Scenario, sandbox: Sandbox, pair: RecordedPair, found: Pair["known"]): Promise<string> {
  const folder = join(FIXTURE_ROOT, harness, PAIRS_FOLDER, scenario.name)
  const before = await readFile(join(folder, "pair.json"), "utf8").then((text) => PairSchema.parse(JSON.parse(text)), () => undefined)
  await rm(folder, { recursive: true, force: true })
  await mkdir(join(folder, "home"), { recursive: true })
  const replacements = rootReplacements(sandbox)
  const scrub = rootedAt(replacements)
  const header = { capture: 1, harness, session: pair.recording.session, native: pair.recording.native }
  const prompts = pair.recording.prompts ?? []
  const promptLine = ({ text, run, attachments, steered }: Prompt): JsonObject => {
    if (steered) return { steered: true, text: text ?? "" }
    const line: JsonObject = { prompted: true }
    if (text !== undefined) line.text = text
    if (run !== undefined) line.run = run
    if (attachments?.length) line.attachments = attachments.map(({ name, mimeType }) => ({ name, mimeType }))
    return line
  }
  const body = pair.recording.messages.flatMap((message, index) => [...prompts.filter((prompt) => prompt.at === index).map(promptLine), { message }])
  body.push(...prompts.filter((prompt) => prompt.at >= pair.recording.messages.length).map(promptLine))
  const lines = [header, ...body].map((line) => JSON.stringify(line))
  await writeFile(join(folder, "capture.jsonl"), linesRootedAt(replacements)(`${lines.join("\n")}\n`))
  await copyScrubbed(recorder.storeFolder?.(pair.store) ?? dirname(pair.store), join(folder, "home"), sandbox.home, replacements, recorder.keeps)
  const reasons = new Map(before?.known.map((difference) => [`${difference.side}${difference.line}`, difference.reason]))
  const kept: Pair = {
    harness,
    native: { version: pair.version },
    about: `${scenario.turns.map((turn) => turn.prompt).join(" / ")} ${scenario.about}`,
    store: scrub(relative(sandbox.home, pair.store)),
    known: found.map((difference) => ({ ...difference, line: scrub(difference.line), reason: reasons.get(`${difference.side}${scrub(difference.line)}`) ?? "" })),
  }
  await writeFile(join(folder, "pair.json"), `${JSON.stringify(kept, null, 2)}\n`)
  const identity = machineIdentity()
  await scrubTree(folder, identity)
  const leaks = await treeLeaks(folder, identity)
  if (leaks.length) {
    await rm(folder, { recursive: true, force: true })
    throw new Error(`The ${harness} ${scenario.name} pair still identified someone after scrubbing, so it wasn't kept (values not printed):\n${describeLeaks(leaks)}`)
  }
  return folder
}

async function copyScrubbed(from: string, into: string, home: string, replacements: readonly Replacement[], keeps: (file: string) => boolean): Promise<void> {
  const info = await stat(from).catch(() => null)
  if (!info) return
  if (info.isDirectory()) {
    for (const entry of await readdir(from)) await copyScrubbed(join(from, entry), into, home, replacements, keeps)
    return
  }
  if (!keeps(from)) return
  const scrub = rootedAt(replacements)
  const target = join(into, scrub(relative(home, from)))
  await mkdir(dirname(target), { recursive: true })
  if (from.endsWith(".jsonl")) await writeFile(target, linesRootedAt(replacements)(await readFile(from, "utf8")))
  else if (/\.(json|md|txt)$/.test(from)) await writeFile(target, scrub(await readFile(from, "utf8")))
  else if (from.endsWith(".db")) await copyDatabase(from, target, replacements)
  else await cp(from, target)
}

/**
 * A SQLite store with its write-ahead log folded in and the sandbox's paths
 * replaced in every text value and inside every binary one (`rewriteBlob`),
 * kept in rollback-journal mode: a reader opening
 * a WAL database grows `-wal` and `-shm` files beside it, inside the fixtures.
 */
async function copyDatabase(from: string, target: string, replacements: readonly Replacement[]): Promise<void> {
  await cp(from, target)
  await cp(`${from}-wal`, `${target}-wal`).catch(() => undefined)
  const database = new DatabaseSync(target)
  try {
    rewriteDatabase(database, rootedAt(replacements), rootSubstitutions(replacements))
    database.exec("PRAGMA journal_mode = DELETE")
    database.exec("VACUUM")
  } finally {
    database.close()
  }
  await rm(`${target}-wal`, { force: true })
  await rm(`${target}-shm`, { force: true })
}

/* ------------------------------------------------------------------- run */

const args = process.argv.slice(2)
const write = args.includes("--write")
const named = args.filter((arg) => arg !== "--write")
const harnesses = named.filter((arg) => RECORDERS.has(arg))
const scenarios = named.filter((arg) => !RECORDERS.has(arg))
for (const name of scenarios)
  if (!SCENARIOS.some((scenario) => scenario.name === name))
    throw new Error(`${name} is neither a harness (${[...RECORDERS.keys()].join(", ")}) nor a scenario (${SCENARIOS.map((scenario) => scenario.name).join(", ")})`)

let unexplained = 0
for (const harness of harnesses.length ? harnesses : [...RECORDERS.keys()]) {
  const recorder = RECORDERS.get(harness)!
  for (const scenario of SCENARIOS.filter((candidate) => !scenarios.length || scenarios.includes(candidate.name))) {
    const skipped = unrecordable(recorder, scenario)
    if (skipped) {
      console.log(`${harness} ${scenario.name}: skipped; ${skipped}`)
      continue
    }
    await sandboxed(SANDBOX, harness, async (sandbox) => {
      for (const [file, text] of Object.entries(scenario.files)) {
        await mkdir(dirname(join(sandbox.project, file)), { recursive: true })
        await writeFile(join(sandbox.project, file), text)
      }
      for (const [file, bytes] of Object.entries(scenario.images ?? {})) await writeFile(join(sandbox.project, file), bytes)
      const pair = await recorder.record(sandbox, scenario)
      await credentialFree(pair, await recorder.secrets?.() ?? [])
      const live = liveDrawing(harness, pair.recording)
      const store = await storeDrawing(harness, sandbox.home, pair.store)
      const found = differences(live, store)
      console.log(`${harness} ${pair.version} ${scenario.name}: ${pair.recording.messages.length} wire messages; live draws ${live.length} lines, the store ${store.length}`)
      for (const line of live) console.log(`  live   ${line.slice(0, 180)}`)
      if (found.length) {
        unexplained += found.length
        console.log(`  ${found.length} differences (- live only, + store only):`)
        for (const difference of found) console.log(`    ${difference.side} ${difference.line}`)
      } else console.log("  the store draws the same")
      if (write) console.log(`  kept ${relative(process.cwd(), await keep(harness, recorder, scenario, sandbox, pair, found.map((difference) => ({ ...difference, reason: "" }))))}`)
    })
  }
}
const stray = await strayStores(SANDBOX)
if (stray.length) throw new Error(`A harness wrote outside its sandbox: ${stray.join(", ")}`)
process.exitCode = unexplained ? 1 : 0
