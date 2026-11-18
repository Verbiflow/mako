// Stop on Claude Code with its process kept (`keepStopped`), read on the real model: the one thing the scripted
// model can't prove. `test-claude-stop-live.ts` holds the mechanics on the real CLI against a stand-in; this asks
// the real model to do each thing, stops it, and prints what happened for a person to read. It asserts nothing.
//
// It runs Claude Code through Mako's own driver in a scratch home that already holds a sign-in (one
// `seedScratchHome` made, or any folder with a `.claude` Claude Code is signed in under), never the person's own
// home, in a project folder it makes inside that home and removes afterwards. It spends a few model requests.
//
//   npx tsx --tsconfig tsconfig.scripts.json scripts/probe-claude-stop.ts --home <scratch home> [--model <id>]
//
// What it must show for the change to stand:
//   1. every Stop line says `kept` (connected, interrupted, no error) and a time in the tens of milliseconds, except
//      the one "with a steer queued", which must say `closed` (the CLI lets a command finish when a message is
//      queued behind it, so Mako closes the process there, as it always did);
//   2. "launches" is 1 until that last Stop, then 2: no other Stop started a process;
//   3. the marker file of the stopped command never appears, and no `sleep` of the probe's is left running;
//   4. after the Stop with a background task, nothing starts by itself for 20 s ("turns Claude started itself: 0");
//   5. the message sent right after a Stop gets its first words in about the time a message to an idle session does
//      (compare the two "first words after" lines), not a relaunch later;
//   6. asked what it was doing when interrupted, the model knows its command was interrupted and does not claim it
//      finished, and never mentions the steer's word (`PELICAN`), which Stop dropped from the queue.
import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdirSync, realpathSync } from "node:fs"
import { join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { parseArgs } from "node:util"
import { followHostLog } from "@mako/host/base/host-log"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { installClaude } from "@mako/host/harnesses/claude/index"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { removeScratchSync } from "./lib/scratch-processes.mjs"
import { assertScratchEnvironment, readPersonSignIns, seedScratchHome } from "./scratch-harness-home.ts"

const { values } = parseArgs({ options: { home: { type: "string" }, seed: { type: "string" }, model: { type: "string" } } })
if (!values.home && !values.seed) throw new Error("--seed <new folder> (a scratch home is made there with a copy of your Claude Code sign-in) or --home <scratch home> is required, never your own home")
// `--seed` makes the home as the other probes do: the sign-in's access token without what renews it, handed to
// Claude Code in its environment, which is how a scratch home is signed in (its Keychain is not the person's).
const seeded = values.seed ? seedScratchHome(resolve(values.seed), readPersonSignIns(), { keep: true }) : undefined
if (values.seed && !seeded?.env["CLAUDE_CODE_OAUTH_TOKEN"]) throw new Error("No Claude Code sign-in could be read to seed the scratch home")
const home = realpathSync(seeded?.env["HOME"] ?? resolve(values.home ?? ""))
if (!existsSync(join(home, ".claude")) && !seeded) throw new Error(`${home} holds no .claude: sign Claude Code in there first (or pass --seed)`)
// Credentials, endpoints and the parent session's variables stay behind: the sign-in is the scratch home's own.
// npm's own variables too: run through `npm run` or under nvm they name folders in the person's home.
const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^(ANTHROPIC_|CLAUDE|MAKO_)/.test(name) && !/^(npm_|XDG_)/i.test(name)))
Object.assign(env, { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude"), TMPDIR: join(home, "tmp") })
if (seeded) Object.assign(env, { CLAUDE_CODE_OAUTH_TOKEN: seeded.env["CLAUDE_CODE_OAUTH_TOKEN"], PATH: seeded.env["PATH"] })
assertScratchEnvironment(env, "probe:claude-stop")
mkdirSync(join(home, "tmp"), { recursive: true })
const project = join(home, `probe-claude-stop-${randomUUID().slice(0, 8)}`)
mkdirSync(join(project, ".git"), { recursive: true })

const driver = sealedDrivers([installClaude]).get("claude")
if (!driver) throw new Error("Claude Code's driver isn't registered")
const id = randomUUID()
const events: { at: number; event: LiveDriverEvent }[] = []
let launches = 0
const closes: string[] = []
const unlog = followHostLog((line) => {
  if (line.scope !== "claude-sdk") return
  if (line.message === "initialized") launches += 1
  if (line.message === "stop closes the process" || line.message === "a stop couldn't keep the process") closes.push(`${line.message} ${JSON.stringify(line.fields)}`)
})
const session = () => events.findLast(({ event }) => event.type === "live-session")?.event
const state = () => { const last = session(); return last?.type === "live-session" ? last.session : undefined }
const updates = (since: number) => events.filter(({ at }) => at >= since).flatMap(({ event }) => event.type === "live-update" ? [event.update] : event.type === "live-updates" ? event.updates : [])
const said = (since: number) => updates(since).filter((update) => update.kind === "text").map((update) => update.text).join("")
const until = async (ready: () => boolean, what: string, timeoutMs: number) => {
  for (const deadline = Date.now() + timeoutMs; !ready(); await delay(20)) if (Date.now() > deadline) { console.log(`  (gave up waiting for ${what} after ${timeoutMs / 1000} s)`); return false }
  return true
}
const running = (marker: string) => {
  try { return execFileSync("pgrep", ["-f", marker], { encoding: "utf8" }).trim().split("\n").filter(Boolean).length } catch { return 0 }
}
const settings = values.model ? { model: values.model } : undefined
const prompt = (text: string) => driver.prompt(id, text, [], settings, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
const start = (resume?: string) => driver.start(project, admitted("claude", {
  conversationId: id, ...resume && { resume }, emit: (event) => events.push({ at: Date.now(), event }), modeId: "bypassPermissions",
  mcpSnapshot: async () => ({ cwd: project, generatedAt: Date.now(), servers: [], providers: [] }),
}, { env }))
/** A message, and how long until the model's first words of its answer. */
const firstWords = async (text: string) => {
  const sent = Date.now()
  await prompt(text)
  await until(() => said(sent).length > 0, "the first words", 60_000)
  const took = Date.now() - sent
  await until(() => state()?.status !== "running", "the turn to end", 120_000)
  return { took, answer: said(sent).trim().slice(0, 400) }
}
const stop = async (what: string) => {
  const began = performance.now()
  const closed = closes.length
  await driver.cancel(id).catch((error: Error) => console.log(`  Stop rejected: ${error.message}`))
  const current = state()
  console.log(`Stop ${what}: ${current?.connection === "connected" ? "kept" : "closed"} in ${Math.round(performance.now() - began)} ms (${current?.status}/${current?.connection}, last stop ${current?.lastStop}, error ${current?.error ?? "none"}); launches ${launches}${closes.length > closed ? `; ${closes.slice(closed).join("; ")}` : ""}`)
}

try {
  await start()
  const idle = await firstWords("Reply with the single word READY.")
  console.log(`first words after a message to an idle session: ${idle.took} ms ("${idle.answer}")`)

  // Mid-text.
  let sent = Date.now()
  await prompt("Count from 1 to 400, one number per line, and nothing else.")
  await until(() => said(sent).length > 40, "the count to be under way", 60_000)
  await stop("mid-text")
  console.log(`  it had said ${said(sent).length} characters; ${said(sent).includes("400") ? "it REACHED 400, so it wasn't stopped" : "it stopped before 400"}`)
  const after = await firstWords("Reply with the single word READY.")
  console.log(`first words after a message sent right after that Stop: ${after.took} ms ("${after.answer}")`)

  // Mid-tool.
  const late = join(project, "late.txt")
  await prompt(`Run exactly this one Bash command in the foreground, with a timeout of 120000 ms, then say done: sleep 47; echo late > ${late}`)
  await until(() => running("sleep 47") > 0, "the command to start", 60_000)
  await delay(2_000)
  await stop("mid-tool")
  await delay(3_000)
  console.log(`  its sleep is ${running("sleep 47") ? "STILL RUNNING" : "gone"}; the file it would have written ${existsSync(late) ? "EXISTS" : "doesn't exist"}`)
  const told = await firstWords("In one sentence: what were you doing when I interrupted you, and did it finish?")
  console.log(`asked what it was doing: "${told.answer}"`)

  // A background task, no turn running.
  await prompt("Start exactly this Bash command in the background (run_in_background: true), then reply STARTED and stop: sleep 613")
  await until(() => running("sleep 613") > 0, "the background command to start", 60_000)
  await until(() => state()?.status !== "running", "that turn to end", 120_000)
  console.log(`a background command runs (${state()?.backgroundTasks ?? 0} counted)`)
  const quiet = Date.now()
  await stop("with a background task and no turn")
  await delay(20_000)
  const own = updates(quiet).filter((update) => update.kind === "provider-turn").length
  console.log(`  its sleep is ${running("sleep 613") ? "STILL RUNNING" : "gone"}; turns Claude started itself in the 20 s after: ${own}; the session is ${state()?.status}`)

  // A second Stop, with nothing running.
  await stop("again, with nothing running")

  // Mid-tool with a steer queued behind the command: the one Stop that closes the process.
  await prompt("Run exactly this one Bash command in the foreground, with a timeout of 120000 ms, then say done: sleep 53; echo late > " + late)
  await until(() => running("sleep 53") > 0, "the command to start", 60_000)
  const steering = driver.steering
  if (steering.kind === "supported")
    void steering.steer(id, { id: randomUUID(), expectedRunId: state()?.nativeRunId ?? "", text: "When you are done, also say the word PELICAN.", attachments: [] }).catch(() => {})
  await delay(2_000)
  await stop("mid-tool with a steer queued (expected: closed)")
  await delay(3_000)
  console.log(`  its sleep is ${running("sleep 53") ? "STILL RUNNING" : "gone"}; the file ${existsSync(late) ? "EXISTS" : "doesn't exist"}`)
  if (state()?.connection !== "connected") await start(state()?.nativeId)
  const last = await firstWords("In two sentences: list what I asked you to do in this conversation and which of them finished. Do not run anything.")
  console.log(`asked for its account: "${last.answer}"`)
  console.log(`  ${/PELICAN/i.test(last.answer) ? "it MENTIONS the dropped steer" : "it doesn't mention the dropped steer"}; launches ${launches}`)
} finally {
  unlog()
  await Promise.resolve(driver.close(id)).catch(() => {})
  await driver.stop?.()
  for (const marker of ["sleep 47", "sleep 613", "sleep 53"]) if (running(marker)) console.log(`LEFT RUNNING: ${marker}`)
  removeScratchSync(project)
}
