import "./lib/scratch-git.mjs"
// A question the agent asks in its harness's widest access, through Mako's own
// host. Each harness whose live driver declares questions starts in the mode
// its session lists as full access, against the scripted model (no account;
// nothing leaves this machine), and its model asks through the harness's own
// question tool. The question must reach the person as an open card in the
// live snapshot; the person's answer, the second option and so never a
// default, must reach the model and the turn end on it; and a host started
// again over the same data must draw the same question and answer from the
// harness's saved session. Codex asks both ways it can: `request_user_input`,
// which waits, and `request_user_input_async`, which stays in the
// conversation. Claude also plans from full access, where its own
// EnterPlanMode takes it: ExitPlanMode reaches the person as a plan card, and
// approving it returns the session to full access. A harness that declares no
// questions is reported with its reason.
//
// The Agent SDK warns, on every query it starts in bypassPermissions with a
// canUseTool, that the callback won't be invoked. This is the proof that it
// is, so the host drops that warning by its code (`base/process-warnings.ts`)
// and its output here must not carry it.
//
//   npm run test:full-access-questions [-- <harness>...]
//
// Harnesses run as Mako finds them (the Agent SDK's own Claude Code; PATH,
// CODEX_EXECUTABLE, OPENCODE_BIN_PATH, DEVIN_CLI_PATH), each in a sandbox of
// its own; one that isn't installed is skipped.
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { z } from "zod"
import { DISABLED_HOST_WARNINGS } from "@mako/host/base/process-warnings"
import { ConversationControlSchema } from "@mako/host/contracts/conversation-control"
import { latestPendingQuestion, LiveInputQuestionSchema } from "@mako/host/contracts/live-questions"
import { LiveRequestSchema } from "@mako/host/conversations/live-journal"
import { EntrySchema, type Entry } from "@mako/sessions"
import { storeDrawing } from "./decode-compare.ts"
import { planFile, script, type Call, type Turn } from "./decode-scenarios.ts"
import { sandboxed, type Sandbox } from "./harness-sandbox.ts"
import type { ScriptedReply } from "./scripted-model.ts"
import { scriptedModel } from "./scripted-model.ts"
import { scriptedWindsurf } from "./scripted-windsurf.ts"
import { startHost, type StartedHost } from "./linux-host/host-process.mjs"

/** What this test reads of a live snapshot. */
const SnapshotSchema = z.object({
  session: z.object({
    status: z.string(),
    error: z.string().optional(),
    modes: z.array(z.object({ id: z.string(), access: z.string().optional(), enforcement: z.string().optional() }).loose()),
    currentMode: z.string().nullable(),
    launchMode: z.string().optional(),
    nativePath: z.string().optional(),
  }).loose(),
  permissions: z.array(z.object({
    id: z.string(),
    title: z.string().optional(),
    questions: z.array(LiveInputQuestionSchema).optional(),
    implementsPlan: z.object({ plan: z.string(), approve: z.string() }).optional(),
  }).loose()),
  requests: z.array(LiveRequestSchema),
  control: ConversationControlSchema.optional(),
  blocks: z.array(EntrySchema),
  base: z.object({ entries: z.array(EntrySchema) }).loose().nullish(),
  baseSource: z.object({ path: z.string() }).loose().optional(),
}).loose()
type Snapshot = z.infer<typeof SnapshotSchema>
const DescriptorsSchema = z.array(z.object({
  provider: z.string(),
  capabilities: z.object({ questions: z.object({ state: z.string(), via: z.string().optional(), reason: z.string().optional() }).loose() }).loose(),
}).loose())
const AvailabilitySchema = z.record(z.string(), z.boolean())

const QUESTION = {
  header: "Release day",
  question: "Which day should the release ship?",
  options: [{ label: "Friday", description: "Keep the day the notes name." }, { label: "Monday", description: "Move it past the weekend." }],
}
/** The person's answer: the second option, which no harness picks for them. */
const ANSWER = "Monday"
const PICKED = `You picked ${ANSWER}.`
const ASK = "Ask me with your question tool, once, which day the release should ship, then tell me what I picked. Don't run commands."
const ASK_LATER = "Ask me which day the release should ship with your question tool that doesn't wait for the answer, then end your turn. Don't run commands."
const PLAN = "Enter plan mode, plan how to move the release to another day, and propose the plan."

/** Each harness's own question tool as its model calls it, in the vocabulary `harness-decode-pairs.ts` records with. */
const ASKS = new Map<string, Call>([
  ["claude", { name: "AskUserQuestion", arguments: { questions: [{ ...QUESTION, multiSelect: false }] } }],
  ["codex", { name: "request_user_input", arguments: { questions: [{ id: "release_day", ...QUESTION }] } }],
  ["grok", { name: "ask_user_question", arguments: { questions: [{ question: QUESTION.question, options: QUESTION.options }] } }],
  ["opencode", { name: "question", arguments: { questions: [QUESTION] } }],
  ["devin", { name: "ask_user_question", arguments: { questions: [QUESTION] } }],
])
const ASK_LATER_CALL: Call = { name: "request_user_input_async", arguments: { questions: [{ title: QUESTION.question, options: QUESTION.options.map((option) => option.label) }] } }

/** The turns each harness takes: its question, then what only it has. Codex's answer to a question that didn't wait is the next message Mako sends. */
function turns(harness: string, ask: Call): Turn[] {
  const asked: Turn = { prompt: ASK, steps: [{ call: () => ask }, { text: PICKED }] }
  if (harness === "codex") return [asked, { prompt: ASK_LATER, steps: [{ call: () => ASK_LATER_CALL }, { text: "I asked." }] }, { prompt: ANSWER, steps: [{ text: PICKED }] }]
  if (harness === "claude") return [asked, { prompt: PLAN, steps: [
    { call: () => ({ name: "EnterPlanMode", arguments: {} }) },
    { call: (_tools, _project, heard) => ({ name: "Write", arguments: { file_path: planFile("Claude Code", heard), content: "1. Move the release to Monday.\n2. Tell QA the new day." } }) },
    { call: () => ({ name: "ExitPlanMode", arguments: {} }) },
    { text: "The plan is approved." },
  ] }]
  return [asked]
}

/** Points the harness Mako launches at the stand-in model, through what the person's own setup would hold. */
async function pointAt(harness: string, sandbox: Sandbox, url: string, env: NodeJS.ProcessEnv): Promise<void> {
  switch (harness) {
    case "claude":
      // Mako launches the CLI's own login without a key or endpoint from its environment (`nativeEnv`); the CLI's settings are the person's.
      await mkdir(join(sandbox.home, ".claude"), { recursive: true })
      await writeFile(join(sandbox.home, ".claude", "settings.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: url, ANTHROPIC_API_KEY: "mako-questions", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" } }))
      // As Claude Code leaves it after its first run; Mako reads who is signed in from it.
      await writeFile(join(sandbox.home, ".claude.json"), "{}")
      return
    case "codex":
      await mkdir(join(sandbox.home, ".codex"), { recursive: true })
      await writeFile(join(sandbox.home, ".codex", "config.toml"), `openai_base_url = "${url}/v1"\nchatgpt_base_url = "${url}/backend-api"\n\n[features]\nplugins = false\n`)
      await writeFile(join(sandbox.home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "mako-questions" }))
      if (process.env.CODEX_EXECUTABLE) env.CODEX_EXECUTABLE = process.env.CODEX_EXECUTABLE
      return
    case "grok":
      Object.assign(env, { GROK_HOME: join(sandbox.home, ".grok"), XAI_API_KEY: "mako-questions", GROK_XAI_API_BASE_URL: `${url}/v1`, GROK_CLI_CHAT_PROXY_BASE_URL: `${url}/v1`, GROK_MODELS_BASE_URL: `${url}/v1` })
      return
    case "opencode":
      if (process.env.OPENCODE_BIN_PATH) env.OPENCODE_BIN_PATH = process.env.OPENCODE_BIN_PATH
      Object.assign(env, {
        // Anthropic's models only, through the stand-in: OpenCode's own free hosted models would answer otherwise.
        OPENCODE_CONFIG_CONTENT: JSON.stringify({ enabled_providers: ["anthropic"], provider: { anthropic: { options: { baseURL: `${url}/v1`, apiKey: "mako-questions" } } } }),
        OPENCODE_DISABLE_MODELS_FETCH: "1", OPENCODE_DISABLE_AUTOUPDATE: "1",
      })
      return
    case "devin":
      await mkdir(join(sandbox.home, ".config", "devin"), { recursive: true })
      await writeFile(join(sandbox.home, ".config", "devin", "config.json"), JSON.stringify({ auto_update: false }))
      if (process.env.DEVIN_CLI_PATH) env.DEVIN_CLI_PATH = process.env.DEVIN_CLI_PATH
      Object.assign(env, { WINDSURF_API_KEY: "mako-questions", WINDSURF_API_SERVER_URL: url, DEVIN_API_URL: url, WINDSURF_WEBSITE_URL: url, DEVIN_WEBAPP_URL: url })
      return
    default:
      throw new Error(`${harness} declares questions, and this test has no stand-in for its model`)
  }
}

/** Reads the snapshot as the window does, no faster than four times a second, until `done` holds. */
async function until(read: () => Promise<Snapshot>, done: (snapshot: Snapshot) => boolean, label: string): Promise<Snapshot> {
  const deadline = Date.now() + 120_000
  for (;;) {
    const snapshot = await read()
    if (done(snapshot)) return snapshot
    if (snapshot.session.status === "failed" || snapshot.session.status === "closed") throw new Error(`${label}: the session ${snapshot.session.status}: ${snapshot.session.error ?? "no error"}`)
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`)
    await delay(250)
  }
}

/** The question calls and the answers that follow them, as live and saved history each draw them. */
type Asked = { tool: string | undefined; output: string | undefined } | { text: string }
function asked(entries: readonly Entry[]): Asked[] {
  return entries.flatMap((entry): Asked[] => {
    if (entry.type === "tool" && entry.input?.includes(QUESTION.question))
      return [{ tool: entry.name, output: entry.output }]
    if (entry.type === "text" && entry.text === PICKED) return [{ text: entry.text }]
    return []
  })
}

const only = process.argv.slice(2)
const bin = await mkdtemp(join(tmpdir(), "mako-host-bin-"))
// The host as a machine starts it: this checkout's `mako-host`, first on PATH, run by its own first line.
const program = resolve("packages/host/dist/mako-host.js")
await chmod(program, 0o755)
await symlink(program, join(bin, "mako-host"))
try {
  for (const harness of ["claude", "codex", "grok", "opencode", "devin", "cursor"].filter((name) => !only.length || only.includes(name)))
    await sandboxed("mako-full-access-questions", harness, async (sandbox) => {
      const env: NodeJS.ProcessEnv = { ...sandbox.env, PATH: `${bin}:${sandbox.env.PATH}` }
      const data = join(sandbox.root, "mako")
      const output = join(sandbox.root, "host-output.log")
      const start = (): Promise<StartedHost> => startHost({ dataRoot: data, output, env })
      const ask = ASKS.get(harness)
      const scenario = { name: "full-access-questions", about: ASK, files: {}, turns: ask ? turns(harness, ask) : [] }
      // SAFETY: these steps make their calls themselves and never read the vocabulary; only plan and subagent steps do, and there are none.
      const steps = script(scenario, {} as never, sandbox.project)
      /** Each request the model answered, with what it was answered. */
      const heard: { request: string; reply?: ScriptedReply }[] = []
      const reply = (request: string) => {
        const answered = steps.reply(request)
        heard.push({ request, reply: answered })
        return answered
      }
      const model = harness === "devin" ? await scriptedWindsurf({ reply, waits: steps.waits }) : await scriptedModel({
        reply,
        // Grok's key check and model catalog, as harness-decode-pairs.ts answers them.
        answers: new Map([
          ["/v1/api-key", JSON.stringify({ redacted_api_key: "xai-...questions", user_id: "questions", name: "questions", acls: ["api-key:model:*", "api-key:endpoint:*"], api_key_blocked: false, api_key_disabled: false, team_blocked: false })],
          ["/v1/models", JSON.stringify({ object: "list", data: [{ id: "grok-4.6", object: "model", name: "Grok", context_window: 256_000 }] })],
        ]),
      })
      if (ask) await pointAt(harness, sandbox, model.url, env)
      let host = await start()
      try {
        const descriptors = DescriptorsSchema.parse(await host.call("mako:harness-descriptors"))
        const questions = descriptors.find((descriptor) => descriptor.provider === harness)?.capabilities.questions
        assert.ok(questions, `the host lists ${harness}`)
        if (questions.state !== "implemented") {
          assert.equal(ask, undefined, `${harness} declares no questions, yet this test asks through its tool`)
          console.log(`${harness}: no question to ask, as it declares: ${questions.reason ?? questions.state}`)
          return
        }
        assert.ok(ask, `${harness} declares questions (${questions.via}), and this test has no question tool for it`)
        if (!AvailabilitySchema.parse(await host.call("mako:harness-availability"))[harness]) {
          console.log(`${harness}: skipped, not installed`)
          return
        }

        let id = randomUUID()
        const snapshot = async () => SnapshotSchema.parse(await host.call("mako:live-snapshot", id))
        const open = async (modeId?: string) => {
          await host.call("mako:live-start", harness, sandbox.project, { conversationId: id, modeId })
          return until(snapshot, (current) => current.session.status === "ready", "the session to start")
        }
        const ready = await open()
        const full = ready.session.modes.find((mode) => mode.access === "full")
        assert.ok(full, `${harness} lists no full access: ${JSON.stringify(ready.session.modes)}`)
        if (full.enforcement === "launch") {
          // A tier the harness reads as its process starts applies to the next conversation, as the picker says.
          await host.call("mako:live-close", id)
          id = randomUUID()
          await open(full.id)
        } else await host.call("mako:live-mode", id, full.id)
        const inFull = (current: Snapshot) => (full.enforcement === "launch" ? current.session.launchMode : current.session.currentMode) === full.id

        for (const turn of scenario.turns.filter((item) => item.prompt !== ANSWER)) {
          const prompt = randomUUID()
          const ended = (current: Snapshot) => current.session.status === "ready" && current.requests.length > 0 && current.requests.every((request) => request.status === "completed")
          await host.call("mako:live-prompt", id, prompt, turn.prompt)
          if (turn.prompt === PLAN) {
            // Claude Code's EnterPlanMode leaves full access for Plan without asking; its ExitPlanMode asks the person.
            const card = await until(snapshot, (current) => current.permissions.some((request) => request.implementsPlan), "the plan card")
            assert.equal(card.session.currentMode, "plan")
            const plan = card.permissions.find((request) => request.implementsPlan)!
            await host.call("mako:live-permission", id, plan.id, { kind: "choice", optionId: plan.implementsPlan!.approve })
            const built = await until(snapshot, ended, "the planning turn's end")
            assert.ok(inFull(built), `approving the plan returns to ${full.id}, not ${built.session.currentMode}`)
            assert.deepEqual(built.permissions, [], "nothing is left waiting")
            console.log(`${harness}: planned from ${full.id} through its own EnterPlanMode; ExitPlanMode asked as Mako's plan card ("${plan.title}"), approved, back in ${built.session.currentMode}`)
            continue
          }
          // A question that waits arrives as a request; one that doesn't stays in the conversation as a session question.
          const waiting = await until(snapshot, (current) =>
            current.permissions.some((request) => request.questions?.some((item) => item.question === QUESTION.question))
            || (current.control && latestPendingQuestion(current.control, current.requests)?.native.questions.some((item) => item.question === QUESTION.question)) === true,
          "the question card")
          assert.ok(inFull(waiting), `the question came in ${full.id}, not ${waiting.session.currentMode}`)
          const request = waiting.permissions.find((item) => item.questions?.some((question) => question.question === QUESTION.question))
          if (request) {
            const question = request.questions!.find((item) => item.question === QUESTION.question)!
            // An option's answer is its value where the harness gives one (Devin's elicitation titles each option with its description).
            assert.ok(question.options?.some((option) => (option.value ?? option.label) === ANSWER), "the card offers the agent's options")
            await host.call("mako:live-permission", id, request.id, { kind: "answers", answers: { [question.id]: [ANSWER] } })
            console.log(`${harness}: ${ask.name} in ${full.id} reached the person as a question card ("${request.title}"); answered ${ANSWER}`)
          } else {
            const group = latestPendingQuestion(waiting.control!, waiting.requests)!
            // Its turn ends having asked; the card stays, and the answer is the next message.
            const left = await until(snapshot, ended, "the asking turn's end")
            assert.equal(latestPendingQuestion(left.control!, left.requests)?.id, group.id, "the question stays open after its turn")
            const question = group.native.questions.find((item) => item.question === QUESTION.question)!
            await host.call("mako:live-permission", id, group.id, { kind: "answers", answers: { [question.id]: [ANSWER] } })
            console.log(`${harness}: ${ASK_LATER_CALL.name} in ${full.id} stayed open as a question card after its turn; answered ${ANSWER}`)
          }
          const done = await until(snapshot, (current) => {
            const last = current.blocks.at(-1)
            return ended(current) && last?.type === "text" && last.text === PICKED
          }, "the answered turn's end")
          assert.deepEqual(done.permissions, [], "nothing is left waiting")
          assert.equal(done.control && latestPendingQuestion(done.control, done.requests), undefined, "no question is left open")
        }
        assert.ok(steps.done(), `the model was asked for every step: ${steps.taken.join(", ")}`)
        assert.deepEqual(steps.unheard, [])
        // Each request answered with the pick carries the person's answer: the answer's name with the question's
        // own options and the earlier turns' picks taken out, in whatever the wire resends (Codex's socket only what's new).
        const answerIn = (request: string) => request.replaceAll(PICKED, "").replace(/label\W+Monday|Friday\W+Monday/g, "").includes(ANSWER)
        const picks = heard.filter((entry) => entry.reply?.text === PICKED)
        assert.equal(picks.length, scenario.turns.flatMap((turn) => turn.steps).filter((step) => step.text === PICKED).length)
        assert.ok(picks.every((entry) => answerIn(entry.request)), "the model heard the person's answer")
        assert.ok(!answerIn(heard.find((entry) => entry.reply?.call)!.request), "and not before the person gave it")

        const ran = await snapshot()
        const live = asked(ran.blocks)
        await host.stop()
        host = await start()
        // Reopened by a new host, the conversation draws its history from the harness's saved session.
        const reopened = await until(snapshot, (current) => Boolean(current.base?.entries.length), "the reopened conversation's saved history")
        assert.deepEqual(asked(reopened.base!.entries), live, "the reopened conversation draws the same questions and answers")
        const saved = await storeDrawing(harness, harness, sandbox.home, reopened.baseSource?.path ?? ran.session.nativePath!)
        const drawn = saved.filter((line) => line.includes(QUESTION.question) || line.includes(PICKED))
        const calls = drawn.filter((line) => line.startsWith("tool "))
        assert.equal(calls.length, harness === "codex" ? 2 : 1, saved.join("\n"))
        // A question that waits returns the answer as its call's result; Codex's other one, in the message after it.
        assert.ok(calls[0]!.split(" -> ")[1]?.includes(ANSWER), saved.join("\n"))
        if (harness === "codex") assert.ok(drawn.some((line) => line.startsWith("user: ") && line.includes(QUESTION.question) && line.endsWith(ANSWER)), saved.join("\n"))
        console.log(`${harness}: reopened by a new host, live and saved draw the same; its saved session reads\n  ${drawn.map((line) => line.slice(0, 260)).join("\n  ")}`)
      } finally {
        await host.stop()
        await model.close()
        const printed = await readFile(output, "utf8").catch(() => "")
        for (const { code } of DISABLED_HOST_WARNINGS) assert.ok(!printed.includes(code), `the host printed ${code}`)
      }
    })
} finally {
  await rm(bin, { recursive: true, force: true })
}
