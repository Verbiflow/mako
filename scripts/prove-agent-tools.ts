import "./lib/scratch-git.mjs"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { delimiter, dirname, join } from "node:path"
import { promisify, parseArgs } from "node:util"
import { z } from "zod"
import { holdHostLease } from "@mako/host/base/host-idle"
import { accessModeId, type AccessTier } from "@mako/host/contracts/access"
import type { JsonObject, JsonValue } from "@mako/host/contracts/json"
import type { RuntimeValue } from "@mako/host/contracts/runtime"
import { invokeRuntime, runtimeInfo } from "@mako/host/transport/connection"
import { hostCommand, runtimeLocation } from "@mako/host/transport/service"
import { assertOwnHarnessStores } from "./lib/proof-host.ts"
import { assertScratchEnvironment, scratchInstall, scratchKeychain, seedScratchHome } from "./scratch-harness-home.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

/**
 * The `thread`, `settings`, `harness` and `automation` tools on a real host of this checkout's build, in a scratch home:
 * a real OpenCode, whose agent is a scripted model calling each tool through Code Mode, on full access and on ask, and
 * each tool's effect read back from the host by the calls the app reads it with. Below full access it answers the
 * harness's approval and Mako's ask as the person would.
 *
 * Installing a harness is real, so the host's PATH holds only this run's own tools: nothing of the person's can be
 * found or updated, and it stops before any install if Codex resolves outside the scratch home. npm's prefix is
 * under that home too. Everything goes with the root at the end unless `--keep`.
 *
 *   npx tsx --tsconfig tsconfig.scripts.json scripts/prove-agent-tools.ts --root <empty folder> [--opencode 2.2.3]
 *     [--codex-old 0.160.0] [--report <file>] [--keep]
 *
 * Build first (`npm run build:electron`): the host runs from `dist-electron` and `packages/host/dist`.
 */
const { values } = parseArgs({
  options: {
    root: { type: "string" },
    opencode: { type: "string", default: "2.2.3" },
    "codex-old": { type: "string", default: "0.160.0" },
    report: { type: "string" },
    keep: { type: "boolean", default: false },
  },
})
const root = values.root
if (!root) throw new Error("name an empty folder with --root")
await mkdir(root, { recursive: true })
if ((await readdir(root)).length) throw new Error(`${root} isn't empty: give the proof a folder of its own`)
const run = promisify(execFile)

const scratch = seedScratchHome(root, {}, { keep: values.keep })
scratchKeychain(scratch.home)
const home = scratch.home
const checks: Array<{ ok: boolean; what: string }> = []
/** `detail`: what was found instead, as JSON, said only when it failed. */
const check = <Found>(what: string, ok: boolean, detail?: Found) => {
  checks.push({ ok, what })
  console.log(ok ? `PASS ${what}` : `FAIL ${what} ${JSON.stringify(detail)?.slice(0, 400)}`)
}

/** What each `tool <token>` turn's call answered, by its token. */
const answers = new Map<string, string>()
// The input goes as base64: the words reach the model inside a JSON request, which would escape it.
const TOOL = /Call the Mako tool ([a-z_]+) with ([A-Za-z0-9_-]+) \(proof ([a-z0-9-]+)\)/g
let automated = false
const AnswerOf = z.object({ content: z.string() }).loose()
const model = await scriptedModel({
  aside: "Tools proof",
  reply: (text): ScriptedReply => {
    if (text.includes("Reply with the single word AUTOMATED.")) automated = true
    const asked = [...text.matchAll(TOOL)].at(-1)
    if (!asked) return { text: "OK" }
    const [, tool, input, token] = asked
    const id = `call_tool_${token}`
    if (!text.includes(`"${id}"`)) return { call: { id, name: "execute", arguments: { code: `return await tools.mako.${tool}(${Buffer.from(input!, "base64url").toString()})` } } }
    // The tool's answer, as the harness sends it back: the JSON string after the call's id.
    const at = text.lastIndexOf(`"tool_use_id":"${id}"`)
    const found = /"content":("(?:[^"\\]|\\.)*")/.exec(text.slice(at))
    if (found && !answers.has(token!)) answers.set(token!, AnswerOf.safeParse({ content: JSON.parse(found[1]!) }).data?.content ?? "")
    return { text: `done ${token}` }
  },
})
await mkdir(join(home, ".config", "opencode"), { recursive: true })
await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", enabled_providers: ["anthropic"], provider: { anthropic: { options: { baseURL: `${model.url}/v1`, apiKey: "tools-proof" } } } }, null, 2))

// The project, with an automation of its own.
const project = join(home, "projects", "tools-proof")
await mkdir(join(project, ".mako"), { recursive: true })
await writeFile(join(project, "README.md"), "A proof's project.\n")
await writeFile(join(project, ".mako", "automations.json"), JSON.stringify({ automations: [{ id: "proof-run", name: "Proof run", prompt: "Reply with the single word AUTOMATED.", trigger: { kind: "manual" } }] }))
await run("git", ["-C", project, "init", "-q", "-b", "main"], { env: { ...scratch.env } })
await run("git", ["-C", project, "add", "-A"], { env: { ...scratch.env } })
await run("git", ["-C", project, "-c", "user.name=proof", "-c", "user.email=proof@example.invalid", "commit", "-qm", "start"], { env: { ...scratch.env } })

// The host's PATH: this run's own tools and the system's, and nothing else, so no harness of the person's is found.
const tools = join(home, "proof-tools")
await mkdir(tools, { recursive: true })
await symlink(process.execPath, join(tools, "node"))
await symlink(join(dirname(process.execPath), "npm"), join(tools, "npm"))
const npmPrefix = join(home, "npm")
const opencodePrefix = join(home, "opencode")
// `NVM_BIN` is a place harnesses are looked for too, and here it would name the person's.
const { NVM_BIN: _theirs, ...scratchEnv } = scratch.env
const installEnv: NodeJS.ProcessEnv = { ...scratchEnv, NPM_CONFIG_PREFIX: npmPrefix, PATH: [tools, "/usr/bin", "/bin"].join(delimiter) }
await scratchInstall("npm", ["install", "-g", "--prefix", opencodePrefix, "--allow-scripts=@opencode/cli", `@opencode/cli@${values.opencode}`], { env: installEnv })
const hostEnv: NodeJS.ProcessEnv = { ...installEnv, PATH: [join(npmPrefix, "bin"), join(opencodePrefix, "bin"), tools, "/usr/bin", "/bin"].join(delimiter), MAKO_SCREENLESS: "1", OPENCODE_DISABLE_MODELS_FETCH: "1" }
assertScratchEnvironment(hostEnv, "the tools proof's host")

// SAFETY: the electron package's main export is the path of its executable.
const electron = createRequire(import.meta.url)("electron") as string
const dataRoot = join(home, "Library", "Application Support", "mako-tools-proof", "profile")
const command = hostCommand({ executable: electron, args: [process.cwd()], env: { ...hostEnv, MAKO_DATA_ROOT: dataRoot, MAKO_WEB_SOCKET: runtimeLocation(dataRoot).socket } })
const host = spawn(command.executable, command.args, { env: command.env, stdio: "ignore" })
for (const deadline = Date.now() + 60_000; !(await runtimeInfo(runtimeLocation(dataRoot).socket).catch(() => null)); ) {
  if (Date.now() > deadline) throw new Error(`the host didn't start within a minute; its log is ${join(dataRoot, "logs", "host.log")}`)
  await new Promise((resolve) => setTimeout(resolve, 250))
}
const release = await holdHostLease(runtimeLocation(dataRoot).directory)
const client = randomUUID()
const call = (channel: string, args: unknown[]) => invokeRuntime(runtimeLocation(dataRoot).socket, client, channel, args)
await assertOwnHarnessStores(call, dataRoot)

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const Snapshot = z.object({
  threadId: z.string().optional(),
  permissions: z.array(z.object({ id: z.string(), options: z.array(z.object({ optionId: z.string(), kind: z.string().optional() }).loose()) }).loose()).default([]),
  control: z.object({ asks: z.array(z.object({ id: z.string(), want: z.object({ kind: z.string() }).loose() }).loose()).optional() }).loose().optional(),
  requests: z.array(z.object({ id: z.string(), status: z.string(), error: z.string().optional() }).loose()).default([]),
}).loose()
const snapshot = async (id: string) => Snapshot.parse(await call("mako:live-snapshot", [id]))

async function start(access: AccessTier, title: string): Promise<{ conversation: string; thread: string }> {
  const conversation = randomUUID()
  const request = randomUUID()
  await call("mako:live-start", ["opencode", project, { conversationId: conversation, title, worktree: true, modeId: accessModeId(access), initialRequest: { id: request, text: "Say OK.", attachments: [] } }])
  for (const deadline = Date.now() + 2 * 60_000; ; await pause(300)) {
    const shot = await snapshot(conversation)
    const status = shot.requests.find((each) => each.id === request)?.status
    if (status === "completed" && shot.threadId) return { conversation, thread: shot.threadId }
    if (status === "failed" || Date.now() > deadline) throw new Error(`${title} didn't start: ${JSON.stringify(shot.requests)}`)
  }
}

let turns = 0
/** A turn whose agent calls one tool. The harness's own approval is allowed as the person would. Its parsed answer, or the text it said. */
async function tool(conversation: string, name: string, input: JsonObject) {
  const token = `t${++turns}`
  await call("mako:live-prompt", [conversation, randomUUID(), `Call the Mako tool ${name} with ${Buffer.from(JSON.stringify({ clientKey: token, ...input })).toString("base64url")} (proof ${token})`, []])
  for (const deadline = Date.now() + 2 * 60_000; !answers.has(token); await pause(300)) {
    if (Date.now() > deadline) throw new Error(`${name} never answered ${JSON.stringify(input)}: ${JSON.stringify((await snapshot(conversation)).requests.slice(-2))}`)
    const held = (await snapshot(conversation)).permissions[0]
    const allow = held?.options.find((option) => option.kind === "allow_once") ?? held?.options[0]
    if (held && allow) await call("mako:live-permission", [conversation, held.id, { kind: "choice", optionId: allow.optionId }]).catch(() => undefined)
  }
  const text = answers.get(token) ?? ""
  // A refusal's line comes first, then its JSON.
  return AnswerJson.safeParse(text.slice(text.indexOf("{"))).data ?? { text }
}
const AnswerJson = z.string().transform((text, context) => {
  try {
    return z.record(z.string(), z.json()).parse(JSON.parse(text))
  } catch {
    context.addIssue({ code: "custom", message: "not an answer's JSON" })
    return z.NEVER
  }
})
const Outcome = z.object({ outcome: z.string().optional(), refused: z.string().optional(), ask: z.string().optional() }).loose()
const outcomeOf = (answer: JsonValue | RuntimeValue) => Outcome.parse(answer)
const until = async (ok: () => Promise<boolean>, ms = 30_000) => {
  for (const deadline = Date.now() + ms; ; await pause(300)) {
    if (await ok().catch(() => false)) return true
    if (Date.now() > deadline) return false
  }
}

const Titles = z.array(z.object({ thread: z.string(), title: z.string().nullish() }).loose())
const titleOf = async (thread: string) => Titles.parse(await call("mako:thread-titles", [])).find((each) => each.thread === thread)?.title
const archived = async (conversation: string) => z.object({ keys: z.array(z.string()) }).loose().parse(await call("mako:thread-archives", [])).keys.some((key) => key.includes(conversation))
const Harnesses = z.record(z.string(), z.object({ binary: z.string().optional(), installed: z.string().optional(), phase: z.string().optional() }).loose())
const codexFrom = (value: JsonValue | RuntimeValue) => Harnesses.parse(value)["codex"]

async function runProof() {
  await call("mako:open-tab", [{ cwd: project }])
  await call("mako:reload-automations", [])
  const full = await start("full", "Tools on full access")
  const ask = await start("ask", "Tools on ask")

  // thread
  check("thread rename, on full access, answers renamed", outcomeOf(await tool(full.conversation, "thread", { action: "rename", title: "Renamed by its agent" })).outcome === "renamed")
  check("the Thread has the title the host says", await until(async () => (await titleOf(full.thread)) === "Renamed by its agent"), await titleOf(full.thread))
  check("thread archive answers archived", outcomeOf(await tool(full.conversation, "thread", { action: "archive" })).outcome === "archived")
  check("the host lists it archived", await archived(full.conversation), await call("mako:thread-archives", []))
  check("thread restore answers restored", outcomeOf(await tool(full.conversation, "thread", { action: "restore" })).outcome === "restored")
  check("the host no longer lists it archived", !(await archived(full.conversation)))

  // Below full access: asked, nothing happens, the person's answer does it.
  const renaming = outcomeOf(await tool(ask.conversation, "thread", { action: "rename", title: "Allowed by the person" }))
  check("below full access, thread rename only asks", renaming.outcome === "asked", renaming)
  check("nothing changed on the agent's word", (await titleOf(ask.thread)) !== "Allowed by the person")
  check("the ask is in the conversation", (await snapshot(ask.conversation)).control?.asks?.some((each) => each.id === renaming.ask) === true, (await snapshot(ask.conversation)).control)
  await call("mako:agent-ask-answer", [ask.conversation, renaming.ask, true])
  check("allowed, the Thread has the title", await until(async () => (await titleOf(ask.thread)) === "Allowed by the person"), await titleOf(ask.thread))
  check("answered, the ask is gone", !(await snapshot(ask.conversation)).control?.asks?.length)

  // settings
  const Read = z.object({ settings: z.object({ handOff: z.looseObject({}), conversations: z.object({ continueAfterRestart: z.boolean() }), harnessOrder: z.array(z.string()) }) }).loose()
  const before = Read.parse(await tool(full.conversation, "settings", { action: "read" }))
  check("settings read answers what Settings reads", true)
  const flipped = !before.settings.conversations.continueAfterRestart
  check("settings set continue-after-restart", outcomeOf(await tool(full.conversation, "settings", { action: "set", setting: "continue-after-restart", value: flipped })).outcome === "set")
  check("the host reads the new value", z.object({ continueAfterRestart: z.boolean() }).parse(await call("mako:conversation-settings", [])).continueAfterRestart === flipped)
  check("settings set harness-order", outcomeOf(await tool(full.conversation, "settings", { action: "set", setting: "harness-order", value: ["opencode", "codex"] })).outcome === "set")
  check("the host reads the new order", z.array(z.string()).parse(await call("mako:harness-order-saved", []))[0] === "opencode", await call("mako:harness-order-saved", []))
  check("a bad value is refused", outcomeOf(await tool(full.conversation, "settings", { action: "set", setting: "continue-after-restart", value: "yes" })).refused === "bad-value")
  const setting = outcomeOf(await tool(ask.conversation, "settings", { action: "set", setting: "continue-after-restart", value: !flipped }))
  check("below full access, settings set only asks", setting.outcome === "asked", setting)
  await call("mako:agent-ask-answer", [ask.conversation, setting.ask, true])
  check("allowed, the setting changes", await until(async () => z.object({ continueAfterRestart: z.boolean() }).parse(await call("mako:conversation-settings", [])).continueAfterRestart === !flipped))

  // automation
  const listed = z.object({ automations: z.array(z.object({ id: z.string(), enabled: z.boolean() }).loose()) }).loose().parse(await tool(full.conversation, "automation", { action: "list" }))
  check("automation list has the project's", listed.automations.some((each) => each.id === "proof-run"), listed)
  check("an id nobody has is refused", outcomeOf(await tool(full.conversation, "automation", { action: "run", id: "nobody" })).refused === "no-automation")
  const run1 = outcomeOf(await tool(ask.conversation, "automation", { action: "run", id: "proof-run" }))
  check("below full access, automation run only asks", run1.outcome === "asked", run1)
  await call("mako:agent-ask-answer", [ask.conversation, run1.ask, true])
  check("allowed, the automation ran", await until(async () => automated, 60_000), "its prompt never reached a model")

  // harness: every step reads where Codex is first, and stops if it's anywhere but here.
  check("harness read answers the harnesses' versions", outcomeOf(await tool(full.conversation, "harness", { action: "read" })).outcome === "read")
  // The guard reads afresh, by the host's own call: this has to be true before anything installs.
  const found = codexFrom(await call("mako:harness-updates", [true]))
  if (found?.binary && !found.binary.startsWith(home)) throw new Error(`refused: Codex resolves to ${found.binary}, outside this run's root; nothing was installed`)
  check("Codex isn't installed here", !found?.binary, found)
  const installing = outcomeOf(await tool(full.conversation, "harness", { action: "install", harness: "codex" }))
  check("harness install starts or finishes", installing.outcome === "started" || installing.outcome === "finished", installing)
  check("Codex landed in this run's npm prefix", await until(async () => codexFrom(await call("mako:harness-updates", [true]))?.binary?.startsWith(home) === true, 5 * 60_000), codexFrom(await call("mako:harness-updates", [true])))
  const tested = codexFrom(await call("mako:harness-updates", [true]))?.installed
  await scratchInstall("npm", ["install", "-g", "--prefix", npmPrefix, `@openai/codex@${values["codex-old"]}`], { env: installEnv })
  const old = await until(async () => codexFrom(await call("mako:harness-updates", [true]))?.installed !== tested, 60_000)
  check("an older Codex stands in its place", old, codexFrom(await call("mako:harness-updates", [true])))
  const updating = outcomeOf(await tool(ask.conversation, "harness", { action: "update", harness: "codex" }))
  check("below full access, harness update only asks", updating.outcome === "asked", updating)
  await call("mako:agent-ask-answer", [ask.conversation, updating.ask, true])
  check("allowed, Codex is updated", await until(async () => codexFrom(await call("mako:harness-updates", [true]))?.installed === tested, 5 * 60_000), codexFrom(await call("mako:harness-updates", [true])))
}

let failure: unknown
try {
  await runProof()
} catch (error) {
  failure = error
  console.error(error)
}
const logs = join(dataRoot, "logs", "host.log")
await run("grep", ["-E", "agent-asks|harness-tool", logs]).then(({ stdout }) => console.log(stdout), () => undefined)
const exited = host.exitCode === null && host.signalCode === null ? new Promise((resolve) => host.once("exit", resolve)) : Promise.resolve()
host.kill("SIGTERM")
await exited
await release?.()
await model.close()
scratch.dispose()
const passed = checks.filter((each) => each.ok).length
const summary = `${passed} of ${checks.length} checks passed${failure ? ", and the run stopped early" : ""}`
if (values.report) await writeFile(values.report, `${JSON.stringify({ summary, checks }, null, 2)}\n`)
if (!values.keep) await rm(root, { recursive: true, force: true })
console.log(summary)
process.exit(failure || passed !== checks.length ? 1 : 0)
