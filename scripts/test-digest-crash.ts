import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { mock } from "node:test"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DIGEST_AGAIN } from "@mako/host/contracts/children"
import { readFinReports } from "@mako/host/contracts/fin-reports"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { AgentsWorld, HARNESSES, TESTED_HARNESSES, type Heard } from "./lib/agents-world.ts"

/**
 * A Fin's question through a real SIGKILL between its hand-off and its receipt (`npm run test:wake-queue`), on each
 * harness as the Apex:
 * - `digest-sent`: the journal says the digest was handed over, and the host dies before the harness has it.
 * - `digest-heard`: the harness has the digest, and the host dies before anything says so.
 * - `steer-sent`: a steer carrying the question is written as under way, on a harness that takes one at a step, and
 *   the host dies before the harness has it.
 * - `steer-heard`: that harness has the steer, and the host dies before its receipt.
 * - `digest-sent-lookalike`: as `digest-sent`, with a line of the digest already in the transcript: only the digest's
 *   own message id proves it arrived, never its words.
 * - `digest-sent-limit`: as `digest-sent`, and the next host's harness refuses it at a usage limit past the retries: it
 *   rests as a digest, tries every hour, and goes when it can, with what its Fin said since behind it.
 * In every case the Apex hears the question once: from the first host, or from the next, which reads the harness's
 * transcript to see whether it's needed.
 */
const POINTS = ["digest-sent", "digest-heard", "steer-sent", "steer-heard", "digest-sent-lookalike", "digest-sent-limit"] as const
type Point = (typeof POINTS)[number]
const STEERS = ["claude", "opencode"]
const QUESTION = "Rerun once more, or hold?"
/** A line of a digest as a person might have pasted one, or as a question might hold. */
const LOOKALIKE = `{"version":1}`
const LIMIT = "You have reached your usage limit. Try again later."
const NEWS = "Fixed it myself."
const realNow = Date.now.bind(Date)
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(what: string, done: () => boolean, ms = 20_000): Promise<void> {
  const deadline = performance.now() + ms
  while (!done()) {
    if (performance.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

function deliveryPayload(text: string): string {
  return text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
}

function questionWords(text: string, report: string, label: string): void {
  const payload = readFinReports(deliveryPayload(text))
  assert.ok(payload.text.includes(QUESTION), `${label}: the delivered prose contains the original question`)
  assert.ok(payload.reports.find((card) => card.report === report)?.line.includes(QUESTION), `${label}: the matching report card contains the original question`)
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
    if ((point.startsWith("digest-sent") && handed) || (point === "steer-sent" && steer)) process.kill(process.pid, "SIGKILL")
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
        writeFileSync(join(root, "fin"), turn.conversation)
        await asking
        await turn.world.agents.report(turn.caller, { status: "blocked", summary: "Main is red.", question: point === "digest-sent-lookalike" ? `${QUESTION}\n${LOOKALIKE}` : QUESTION, options: [{ label: "Rerun" }, { label: "Hold" }], clientKey: "question" })
      }
      return "ok"
    },
  })
  const apex = await world.apex(harness, "full")
  writeFileSync(join(root, "apex"), apex.conversation)
  const started = await world.agents.start(apex.caller, { brief: { objective: "Land it" }, harness: "codex", name: "worker", clientKey: "worker", cwd: world.root })
  assert.ok(!("refused" in started), JSON.stringify(started))
  await until("the Fin's turn", () => world.prompts.some((prompt) => prompt.conversation !== apex.conversation))
  if (point === "digest-sent-lookalike") {
    world.say(apex.conversation, `Earlier unrelated schema:\n${LOOKALIKE}`)
    await until("that turn", () => world.prompts.some((prompt) => prompt.conversation === apex.conversation && prompt.text.includes(LOOKALIKE)))
    await until("its end", () => world.live.session(apex.conversation)?.status === "ready")
  }
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
  let refusing = point === "digest-sent-limit"
  let refusals = 0
  let now = realNow()
  const clock = point === "digest-sent-limit" ? mock.method(Date, "now", () => now) : undefined
  const world = new AgentsWorld({
    root,
    transcripts: true,
    script: async () => "ok",
    heard: (line) => appendFileSync(join(root, "heard.ndjson"), `${JSON.stringify(line)}\n`),
    refusePrompt: (id) => {
      if (id !== apex || !refusing) return undefined
      refusals += 1
      return LIMIT
    },
  })
  try {
    const fin = world.store.journalPlacement(readFileSync(join(root, "fin"), "utf8"))!
    const question = world.store.reportsOf(fin.thread).find((report) => report.id.endsWith(":question"))!
    assert.ok(question, `${label}: the original question is stored`)
    // Later inputs can repeat this question in pending control context. Only its structured report card is delivery.
    const deliveries = (heard: readonly Heard[]) => heard.filter((line) => line.conversation === apex && readFinReports(line.text).reports.some((report) => report.report === question.id))
    const told = () => deliveries(lines())
    if (point === "digest-sent-limit") {
      const replay = () => world.live.snapshot(apex)?.requests.find((request) => request.continues?.brief && request.digest)
      await until(`${label}: the replay, a digest, to be refused`, () => replay()?.retry !== undefined)
      const retry = replay()!.retry!
      assert.equal(told().length, 0, `${label}: nothing has reached it`)
      // Its retries run out, and it rests.
      now = retry.since + 6 * 3_600_000 + 1
      world.live.wakeDue(now)
      await until(`${label}: the digest to rest`, () => world.live.snapshot(apex)?.requests.some((request) => request.digest?.resting === true && request.status === "held") === true)
      // Each hour it tries by itself.
      const before = refusals
      now += 3_600_000 + 1
      world.live.wakeDue(now)
      await until(`${label}: its hourly try`, () => refusals > before)
      refusing = false
      await until(`${label}: the digest at rest to be waiting again`, () => world.live.snapshot(apex)?.requests.some((request) => request.digest?.resting === true && request.status === "held") === true)
      await world.agents.report(world.caller(readFileSync(join(root, "fin"), "utf8")), { status: "done", summary: NEWS, clientKey: "news" })
      await pause(500)
      now += 3_600_000 + 1
      world.live.wakeDue(now)
      await until(`${label}: the Apex to hear the question`, () => told().length > 0)
      await pause(500)
      now += 3_600_000 + 1
      world.live.wakeDue(now)
      await until(`${label}: the Apex to hear what came after`, () => lines().some((line) => line.conversation === apex && line.text.includes(NEWS)))
    }
    await until(`${label}: the Apex to hear the question`, () => told().length > 0)
    if (point !== "digest-sent-limit") await world.settle(400, 20_000, "ignore")
    else await pause(300)
    assert.equal(world.store.undeliveredReports().length, 0, `${label}: every report is heard`)
    const observed = lines()
    const once = (heard: readonly Heard[]) => assert.equal(deliveries(heard).length, 1, `${label}: once, a transcript that shows it saying so`)
    once(observed)
    questionWords(told()[0]!.text, question.id, label)
    const original = told()[0]!
    const payload = deliveryPayload(original.text)
    const missingWords = { ...original, text: original.text.slice(0, original.text.length - payload.length) + payload.replaceAll(QUESTION, "Question removed.") }
    assert.equal(deliveries([missingWords]).length, 1, `${label}: removing question words preserves the report identity`)
    assert.throws(() => questionWords(missingWords.text, question.id, label), { code: "ERR_ASSERTION" }, `${label}: control context cannot replace missing delivered question words`)
    const planted = [...observed, { ...told()[0]! }]
    assert.equal(deliveries(planted).length, 2, `${label}: a planted duplicate is still counted`)
    assert.throws(() => once(planted), { code: "ERR_ASSERTION" }, `${label}: the same once-only guard rejects the duplicate`)
    const evidence = process.env.DIGEST_CRASH_EVIDENCE
    if (evidence) {
      const mentions = observed.filter((line) => line.conversation === apex && line.text.includes(QUESTION))
      const entries = mentions.map((line) => {
        const payload = deliveryPayload(line.text)
        return { kind: line.kind, payload, contextOnly: !payload.includes(QUESTION), reports: readFinReports(line.text).reports.map((report) => report.report) }
      })
      appendFileSync(evidence, `${JSON.stringify({ point, harness: told()[0]!.harness, report: question.id, rawQuestionEntries: mentions.length, payloadQuestionEntries: entries.filter((entry) => !entry.contextOnly).length, reportDeliveries: deliveries(observed).length, plantedDuplicateDeliveries: deliveries(planted).length, duplicateRejected: true, missingQuestionRejected: true, entries })}\n`)
    }
    if (point.startsWith("digest-sent")) assert.ok(told()[0]!.text.includes(DIGEST_AGAIN), `${label}: framed as maybe repeated`)
  } finally {
    await world.close()
    clock?.mock.restore()
  }
}

if (process.argv[2] === "--host") await host(process.argv[3]!, process.argv[4]!, POINTS.find((each) => each === process.argv[5])!)
else {
  const root = mkdtempSync(join(tmpdir(), "mako-digest-crash-"))
  const failures: string[] = []
  try {
    for (const point of POINTS)
      for (const harness of (point.startsWith("steer") ? STEERS : HARNESSES).filter((harness) => TESTED_HARNESSES.some((tested) => tested === harness))) {
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
