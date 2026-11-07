import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mock } from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DIGEST_AGAIN } from "@mako/host/contracts/children"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { AgentsWorld, HARNESSES, type Heard } from "./lib/agents-world.ts"

/**
 * A Fin's question through a real SIGKILL between its hand-off and its receipt (`npm run test:wake-queue`), on each
 * harness as the Apex:
 * - `digest-sent`: the journal says the digest was handed over, and the host dies before the harness has it.
 * - `digest-heard`: the harness has the digest, and the host dies before anything says so.
 * - `steer-sent`: a steer carrying the question is written as under way, on a harness that takes one at a step, and
 *   the host dies before the harness has it.
 * - `steer-heard`: that harness has the steer, and the host dies before its receipt.
 * In every case the Apex hears the question once: from the first host, or from the next, which reads the harness's
 * transcript to see whether it's needed.
 */
const POINTS = ["digest-sent", "digest-heard", "steer-sent", "steer-heard"] as const
type Point = (typeof POINTS)[number]
const STEERS = ["claude", "opencode"]
const QUESTION = "Rerun once more, or hold?"
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, ms = 20_000): Promise<void> {
  const deadline = performance.now() + ms
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

async function host(root: string, harness: string, point: Point): Promise<void> {
  mkdirSync(root, { recursive: true })
  const heard = join(root, "heard.ndjson")
  const steering = point.startsWith("steer")
  const commit = LiveJournal.prototype.commit
  mock.method(LiveJournal.prototype, "commit", function (this: LiveJournal, ...args: Parameters<LiveJournal["commit"]>) {
    commit.apply(this, args)
    const [snapshot] = args
    const handed = snapshot.requests.some((request) => request.digest && request.text.includes(QUESTION) && request.nativeDelivery?.evidence.kind === "submitted")
    const steer = snapshot.control?.actions?.some((action) => action.input.kind === "steer" && action.input.text.includes(QUESTION))
    if ((point === "digest-sent" && handed) || (point === "steer-sent" && steer)) process.kill(process.pid, "SIGKILL")
  })
  let asked!: () => void
  const asking = new Promise<void>((resolve) => { asked = resolve })
  const world: AgentsWorld = new AgentsWorld({
    root,
    transcripts: true,
    heard: (line) => {
      appendFileSync(heard, `${JSON.stringify(line)}\n`)
      if (line.text.includes(QUESTION) && ((point === "digest-heard" && line.kind === "prompt") || (point === "steer-heard" && line.kind === "steer"))) process.kill(process.pid, "SIGKILL")
    },
    script: async (turn) => {
      if (turn.text.includes("Keep busy.")) return turn.world.hold(turn.conversation).then(() => "Done.")
      if (turn.text.includes("You're fin:")) {
        await asking
        await turn.world.agents.report(turn.caller, { status: "blocked", summary: "Main is red.", question: QUESTION, options: [{ label: "Rerun" }, { label: "Hold" }], clientKey: "question" })
      }
      return "ok"
    },
  })
  const apex = await world.apex(harness, "full")
  writeFileSync(join(root, "apex"), apex.conversation)
  const started = await world.agents.start(apex.caller, { brief: { objective: "Land it" }, harness: "codex", name: "worker", clientKey: "worker", cwd: world.root })
  assert.ok(!("refused" in started), JSON.stringify(started))
  await until("the Fin's turn", () => world.prompts.some((prompt) => prompt.conversation !== apex.conversation))
  if (steering) {
    world.say(apex.conversation, "Keep busy.")
    await until("the Apex's turn", () => world.live.session(apex.conversation)?.status === "running")
  }
  asked()
  // Its timers don't hold a process up, and the digest's window is one of them.
  setInterval(() => {}, 1_000)
}

async function next(root: string, point: Point): Promise<void> {
  const label = point
  assert.ok(existsSync(join(root, "apex")), `${label}: the host got that far`)
  const apex = readFileSync(join(root, "apex"), "utf8")
  // SAFETY: this file holds only what `heard` wrote here, each line a `Heard`.
  const lines = (): Heard[] => (existsSync(join(root, "heard.ndjson")) ? readFileSync(join(root, "heard.ndjson"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as Heard) : [])
  const world = new AgentsWorld({ root, transcripts: true, script: async () => "ok", heard: (line) => appendFileSync(join(root, "heard.ndjson"), `${JSON.stringify(line)}\n`) })
  try {
    const told = () => lines().filter((line) => line.conversation === apex && line.text.includes(QUESTION))
    await until(`${label}: the Apex to hear the question`, () => told().length > 0)
    await world.settle(400, 20_000, "ignore")
    assert.equal(world.store.undeliveredReports().length, 0, `${label}: every report is heard`)
    assert.equal(told().length, 1, `${label}: once, a transcript that shows it saying so`)
    if (point === "digest-sent") assert.ok(told()[0]!.text.includes(DIGEST_AGAIN), `${label}: framed as maybe repeated`)
  } finally {
    await world.close()
  }
}

if (process.argv[2] === "--host") await host(process.argv[3]!, process.argv[4]!, POINTS.find((each) => each === process.argv[5])!)
else {
  const root = mkdtempSync(join(tmpdir(), "mako-digest-crash-"))
  const failures: string[] = []
  try {
    for (const point of POINTS)
      for (const harness of point.startsWith("steer") ? STEERS : HARNESSES) {
        const dir = join(root, `${point}-${harness}`)
        try {
          const killed = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "--host", dir, harness, point], { stdio: ["ignore", "ignore", "pipe"], timeout: 40_000, encoding: "utf8" })
          assert.equal(killed.signal, "SIGKILL", `killed where it was meant to: ${killed.stderr.slice(-600)}`)
          await next(dir, point)
        } catch (error) {
          failures.push(`${point} on ${harness}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  if (failures.length) {
    console.error(`${failures.length} failed:\n${failures.join("\n")}`)
    process.exit(1)
  }
  console.log("digest crash: a question between its hand-off and its receipt reached its Apex through a real SIGKILL, on every harness")
}
