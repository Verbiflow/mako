import { execFile, spawn } from "node:child_process"
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { dirname, join, relative } from "node:path"
import { promisify } from "node:util"
import { z } from "zod"
import type { JsonObject, JsonValue } from "../electron/codex-app-json.ts"
import { resolveExecutable } from "../electron/executable.ts"
import { grokAcpSource } from "../electron/providers/grok/acp.ts"
import { differences, liveDrawing, PairSchema, PAIRS_FOLDER, storeDrawing, storeReader, type Pair } from "./decode-compare.ts"
import { RpcMessage, rpcPeer, sandboxed, stop, strayStores, type Sandbox } from "./harness-sandbox.ts"
import { FIXTURE_ROOT, type Recording } from "./native-decoding.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

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
 * sandbox's paths replaced by `PAIR_ROOT`, for `test:decoders` to compare on
 * every run. A rewritten pair keeps the reasons its known differences had.
 */

const SANDBOX = "mako-decode-pairs"
/** Where a kept pair says the sandbox was. */
const PAIR_ROOT = "/tmp/mako-pair"
const TURN_MS = 120_000
const run = promisify(execFile)

/* ------------------------------------------------------------- scenarios */

interface Call {
  name: string
  arguments: JsonObject
}

type TodoStatus = "pending" | "in_progress" | "completed"

/** A harness's own tools, as its model calls them. */
interface ToolVocabulary {
  read(path: string): Call
  shell(command: string, description: string): Call
  edit(path: string, from: string, to: string): Call
  todos(items: { id: string; content: string; status: TodoStatus }[]): Call
}

interface Step {
  reasoning?: string
  text?: string
  call?: (tools: ToolVocabulary, project: string) => Call
}

/** Turns a person could ask for, each answered by a scripted model step by step. */
interface Scenario {
  name: string
  about: string
  files: Record<string, string>
  turns: { prompt: string; steps: Step[] }[]
}

const NOTES = "The release ships on Friday.\nQA signs off on Thursday.\n"

const SCENARIOS: Scenario[] = [
  {
    name: "read-and-answer",
    about: "Reasoning, text, a file read, then the answer.",
    files: { "notes.md": NOTES },
    turns: [{
      prompt: "What do the notes in notes.md say?",
      steps: [
        { reasoning: "The answer is in notes.md, so read it first.", text: "I'll read the notes.", call: (tools, project) => tools.read(join(project, "notes.md")) },
        { reasoning: "The notes give a ship day and a sign-off day.", text: "The notes say the release ships on Friday, after QA signs off on Thursday." },
      ],
    }],
  },
  {
    name: "shell-and-edit",
    about: "A shell command with output, a file edit with its diff, then the answer.",
    files: { "notes.md": NOTES },
    turns: [{
      prompt: "Count the lines in notes.md, then move the release to Monday.",
      steps: [
        { text: "Counting first.", call: (tools) => tools.shell("wc -l notes.md", "Count the lines in notes.md") },
        { reasoning: "Two lines. Now the edit.", call: (tools, project) => tools.edit(join(project, "notes.md"), "ships on Friday", "ships on Monday") },
        { text: "notes.md has two lines, and the release now ships on Monday." },
      ],
    }],
  },
  {
    name: "failed-read",
    about: "A read of a file that does not exist fails, and the answer says so.",
    files: { "notes.md": NOTES },
    turns: [{
      prompt: "What does missing.md say?",
      steps: [
        { call: (tools, project) => tools.read(join(project, "missing.md")) },
        { text: "There is no missing.md in this project." },
      ],
    }],
  },
  {
    name: "todos-over-two-turns",
    about: "A todo list in the first turn, updated in the second.",
    files: { "notes.md": NOTES },
    turns: [
      {
        prompt: "Plan the release checklist.",
        steps: [
          { call: (tools) => tools.todos([{ id: "qa", content: "QA sign-off", status: "in_progress" }, { id: "ship", content: "Ship the release", status: "pending" }]) },
          { text: "Two steps: QA signs off, then the release ships." },
        ],
      },
      {
        prompt: "QA signed off.",
        steps: [
          { call: (tools) => tools.todos([{ id: "qa", content: "QA sign-off", status: "completed" }, { id: "ship", content: "Ship the release", status: "in_progress" }]) },
          { text: "QA is done; shipping is next." },
        ],
      },
    ],
  },
]

/** Each conversation request takes the next step, its call numbered in order. */
function script(scenario: Scenario, tools: ToolVocabulary, project: string): () => ScriptedReply | undefined {
  const steps = scenario.turns.flatMap((turn) => turn.steps)
  let next = 0
  return () => {
    const step = steps[next++]
    if (!step) return undefined
    const call = step.call?.(tools, project)
    return { reasoning: step.reasoning, text: step.text, call: call && { id: `call_${next}`, ...call } }
  }
}

/* -------------------------------------------------------------- recorders */

interface RecordedPair {
  version: string
  recording: Recording
  /** The session's store file, under the sandbox's home. */
  store: string
}

interface Recorder {
  /** The store files kept beside a pair: the session's own, not the harness's indexes or prompts. */
  keeps: (file: string) => boolean
  record: (sandbox: Sandbox, scenario: Scenario) => Promise<RecordedPair>
}

const GROK_TOOLS: ToolVocabulary = {
  read: (path) => ({ name: "read_file", arguments: { target_file: path } }),
  shell: (command, description) => ({ name: "run_terminal_command", arguments: { command, description } }),
  edit: (path, from, to) => ({ name: "search_replace", arguments: { file_path: path, old_string: from, new_string: to } }),
  todos: (items) => ({ name: "todo_write", arguments: { merge: false, todos: items } }),
}

/** Grok over ACP, as Mako's ACP source launches it. */
const grok: Recorder = {
  keeps: (file) => /\/sessions\/[^/]+\/[^/]+\/(updates\.jsonl|summary\.json)$/.test(file),
  async record(sandbox, scenario) {
    const version = await versionOf("grok")
    const model = await scriptedModel({
      answers: new Map([
        ["/v1/api-key", JSON.stringify({ redacted_api_key: "xai-...pair", user_id: "pair", name: "pair", acls: ["api-key:model:*", "api-key:endpoint:*"], api_key_blocked: false, api_key_disabled: false, team_blocked: false })],
        ["/v1/models", JSON.stringify({ object: "list", data: [] })],
      ]),
      reply: script(scenario, GROK_TOOLS, sandbox.project),
    })
    const env: NodeJS.ProcessEnv = {
      ...sandbox.env, GROK_HOME: join(sandbox.home, ".grok"), XAI_API_KEY: "mako-decode-pair",
      GROK_XAI_API_BASE_URL: `${model.url}/v1`, GROK_CLI_CHAT_PROXY_BASE_URL: `${model.url}/v1`, GROK_MODELS_BASE_URL: `${model.url}/v1`,
    }
    try {
      const launch = await grokAcpSource.launch({ appPath: process.cwd(), execPath: process.execPath, cwd: sandbox.project, env, access: grokAcpSource.access?.default })
      if (!launch) throw new Error("Grok's ACP source declined to launch")
      launch.configureEnvironment?.(env)
      const wire = await acpSession({ command: launch.command, args: launch.args, env, cwd: sandbox.project }, scenario.turns.map((turn) => turn.prompt))
      const unscripted = model.requests.filter((request) => request.unscripted).length
      if (unscripted) throw new Error(`Grok asked the model ${unscripted} more times than ${scenario.name} has steps`)
      if (!model.requests.some((request) => request.conversation))
        throw new Error(`Grok never asked the scripted model for the turn: ${model.requests.map((request) => request.path).join(", ")}`)
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

const RECORDERS = new Map<string, Recorder>([["grok", grok]])

async function versionOf(command: string): Promise<string> {
  const executable = resolveExecutable(command, process.env)
  if (!executable) throw new Error(`${command} is not installed`)
  const version = /\d+(?:\.\d+)+/.exec((await run(executable, ["--version"])).stdout)?.[0]
  if (!version) throw new Error(`${command} reported no version`)
  return version
}

const Permission = z.object({ options: z.array(z.object({ optionId: z.string(), kind: z.string().optional() }).loose()) }).loose()

/**
 * Prompts over ACP in one session, every message the agent sends recorded as
 * Mako's ACP client records it: `{ method, params }`, or `{ request, params }`
 * for one it waits on. Permission is granted once, as a person allowing the
 * call would.
 */
async function acpSession(input: { command: string; args: string[]; env: NodeJS.ProcessEnv; cwd: string }, prompts: string[]): Promise<Pick<Recording, "messages" | "prompts">> {
  const executable = resolveExecutable(input.command, input.env)
  if (!executable) throw new Error(`${input.command} is not installed`)
  const child = spawn(executable, input.args, { cwd: input.cwd, env: input.env, stdio: ["pipe", "pipe", "pipe"] })
  const messages: JsonValue[] = []
  const sent: number[] = []
  const params = (message: RpcMessage): JsonObject => z.record(z.string(), z.json()).parse(message.params ?? {})
  const peer = rpcPeer(child, {
    jsonrpc: true,
    timeoutMs: TURN_MS,
    refusal: "Mako's decode-pairs client does not answer this",
    received: (message) => {
      if (!message.method) return
      messages.push(message.id === undefined ? { method: message.method, params: params(message) } : { request: message.method, params: params(message) })
    },
    answer: (message) => {
      if (message.method !== "session/request_permission") return undefined
      const { options } = Permission.parse(message.params)
      const option = options.find((candidate) => candidate.kind === "allow_once") ?? options[0]
      return option ? { outcome: { outcome: "selected", optionId: option.optionId } } : undefined
    },
  })
  try {
    await peer.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false } })
    const session = z.object({ sessionId: z.string() }).parse(await peer.call("session/new", { cwd: input.cwd, mcpServers: [] }))
    for (const prompt of prompts) {
      sent.push(messages.length)
      await peer.call("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: prompt }] })
    }
    return { messages, prompts: sent }
  } finally {
    peer.close()
    await stop(child)
  }
}

/* ------------------------------------------------------------------ kept */

/** The sandbox's paths, plain, URL-encoded or dash-encoded, as `PAIR_ROOT`. */
function rootedAt(sandbox: Sandbox): (text: string) => string {
  const roots = [sandbox.root, sandbox.root.replace(/^\/private/, "")]
  const pairs = roots.flatMap((root) => [[root, PAIR_ROOT], [encodeURIComponent(root), encodeURIComponent(PAIR_ROOT)], [root.replaceAll("/", "-"), PAIR_ROOT.replaceAll("/", "-")]])
  return (text) => pairs.reduce((scrubbed, [from, to]) => scrubbed.replaceAll(from!, to!), text)
}

async function keep(harness: string, recorder: Recorder, scenario: Scenario, sandbox: Sandbox, pair: RecordedPair, found: Pair["known"]): Promise<string> {
  const folder = join(FIXTURE_ROOT, harness, PAIRS_FOLDER, scenario.name)
  const before = await readFile(join(folder, "pair.json"), "utf8").then((text) => PairSchema.parse(JSON.parse(text)), () => undefined)
  await rm(folder, { recursive: true, force: true })
  await mkdir(join(folder, "home"), { recursive: true })
  const scrub = rootedAt(sandbox)
  const header = { capture: 1, harness, session: pair.recording.session, native: pair.recording.native }
  const prompts = new Set(pair.recording.prompts)
  const body = pair.recording.messages.flatMap((message, index) => prompts.has(index) ? [{ prompted: true }, { message }] : [{ message }])
  const lines = [header, ...body].map((line) => scrub(JSON.stringify(line)))
  await writeFile(join(folder, "capture.jsonl"), `${lines.join("\n")}\n`)
  await copyScrubbed(dirname(pair.store), join(folder, "home"), sandbox.home, scrub, recorder.keeps)
  const reasons = new Map(before?.known.map((difference) => [`${difference.side}${difference.line}`, difference.reason]))
  const kept: Pair = {
    harness,
    native: { version: pair.version },
    about: `${scenario.turns.map((turn) => turn.prompt).join(" / ")} ${scenario.about}`,
    store: scrub(relative(sandbox.home, pair.store)),
    known: found.map((difference) => ({ ...difference, line: scrub(difference.line), reason: reasons.get(`${difference.side}${scrub(difference.line)}`) ?? "" })),
  }
  await writeFile(join(folder, "pair.json"), `${JSON.stringify(kept, null, 2)}\n`)
  return folder
}

async function copyScrubbed(from: string, into: string, home: string, scrub: (text: string) => string, keeps: (file: string) => boolean): Promise<void> {
  const info = await stat(from).catch(() => null)
  if (!info) return
  if (info.isDirectory()) {
    for (const entry of await readdir(from)) await copyScrubbed(join(from, entry), into, home, scrub, keeps)
    return
  }
  if (!keeps(from)) return
  const target = join(into, scrub(relative(home, from)))
  await mkdir(dirname(target), { recursive: true })
  if (/\.(jsonl?|json|md|txt)$/.test(from)) await writeFile(target, scrub(await readFile(from, "utf8")))
  else await cp(from, target)
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
    await sandboxed(SANDBOX, harness, async (sandbox) => {
      for (const [file, text] of Object.entries(scenario.files)) await writeFile(join(sandbox.project, file), text)
      const pair = await recorder.record(sandbox, scenario)
      const live = liveDrawing(harness, pair.recording)
      const store = await storeDrawing(harness, sandbox.home, pair.store)
      const found = differences(live, store)
      console.log(`${harness} ${pair.version} ${scenario.name}: ${pair.recording.messages.length} wire messages; live draws ${live.length} lines, the store ${store.length}`)
      for (const line of live) console.log(`  live   ${line.slice(0, 180)}`)
      if (found.length) {
        unexplained += found.length
        console.log(`  ${found.length} differences (- live only, + store only):`)
        for (const difference of found) console.log(`    ${difference.side} ${difference.line.slice(0, 220)}`)
      } else console.log("  the store draws the same")
      if (write) console.log(`  kept ${relative(process.cwd(), await keep(harness, recorder, scenario, sandbox, pair, found.map((difference) => ({ ...difference, reason: "" }))))}`)
    })
  }
}
const stray = await strayStores(SANDBOX)
if (stray.length) throw new Error(`A harness wrote outside its sandbox: ${stray.join(", ")}`)
process.exitCode = unexplained ? 1 : 0
