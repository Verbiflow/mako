import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { followHostLog } from "@mako/host/base/host-log"
import { BRIEF_AGAIN } from "@mako/host/contracts/children"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { transcriptHolds } from "@mako/host/conversations/native-history"
import { AgentsWorld, HARNESSES, type Heard, type Script } from "./lib/agents-world.ts"

/**
 * A Fin's brief through a host killed with SIGKILL at its handoff (`npm run test:handoff`), on each of the six
 * harnesses, whose transcripts the next host reads:
 * - `unsaved`: the journal turns read-only as the brief is written as submitted, as a full disk or a lost volume does.
 *   `handOff`, every driver's last step before its transport call, sends nothing; the next host reads the brief as
 *   never sent, so it goes once, whole.
 * - `submitted`: the write holds, and the host dies before the transport call. Whether the harness had it is unknown,
 *   and its transcript doesn't show it: the next host sends the brief again, framed so a Fin that did get it carries
 *   on (`BRIEF_AGAIN`).
 * - `heard`: the harness took it and its transcript shows it: the next host continues the Fin's turn.
 * In none does a Fin that never had its brief get only "Continue where you left off".
 */
const POINTS = ["unsaved", "submitted", "heard"] as const
type Point = (typeof POINTS)[number]
const BRIEF = "You're fin:worker"
const CONTINUE = "Continue where you left off"
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

const script: Script = async () => "Done."

/** The host that dies at `point` of the brief's handoff. */
async function host(dir: string, harness: string, point: Point): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const heard = (line: Heard) => {
    appendFileSync(join(dir, "heard.ndjson"), `${JSON.stringify(line)}\n`)
    // `unsaved` too, as the transport has it: a brief its harness took must not go again.
    if (line.text.includes(BRIEF)) process.kill(process.pid, "SIGKILL")
  }
  let readOnly = false
  const commit = LiveJournal.prototype.commit
  mock.method(LiveJournal.prototype, "commit", function (this: LiveJournal, ...args: Parameters<LiveJournal["commit"]>) {
    const submitted = args[0].requests.some((request) => request.text.includes(BRIEF) && request.nativeDelivery?.evidence.kind === "submitted")
    if (submitted && point === "unsaved") readOnly = true
    if (readOnly) throw Object.assign(new Error("attempt to write a readonly database"), { code: "ERR_SQLITE_ERROR", errcode: 8 })
    commit.apply(this, args)
    if (submitted && point === "submitted") process.kill(process.pid, "SIGKILL")
  })
  followHostLog((line) => {
    if (line.message !== "a message went no further than its handoff") return
    writeFileSync(join(dir, "refused"), JSON.stringify(line.fields ?? {}))
    process.kill(process.pid, "SIGKILL")
  })
  const world = new AgentsWorld({ root: dir, script, heard, transcripts: true })
  const apex = await world.apex("cursor", "full")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Review the sidebar." }, harness, name: "worker", clientKey: "worker", cwd: dir })
  assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
  writeFileSync(join(dir, "fin"), started.conversation!)
  await new Promise(() => {})
}

function run(dir: string, harness: string, point: Point): Promise<{ signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--host", dir, harness, point], { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
    child.on("exit", (_code, signal) => {
      clearTimeout(timer)
      resolve({ signal, stderr })
    })
  })
}

async function check(dir: string, harness: string, point: Point): Promise<void> {
  const label = `${point} on ${harness}`
  const before = existsSync(join(dir, "heard.ndjson")) ? readFileSync(join(dir, "heard.ndjson"), "utf8").split("\n").filter(Boolean).map((line): Heard => JSON.parse(line)) : []
  const fin = readFileSync(join(dir, "fin"), "utf8")
  const had = before.filter((line) => line.conversation === fin && line.text.includes(BRIEF)).length
  assert.equal(had, point === "heard" ? 1 : 0, `${label}: what reached the harness before the kill`)
  if (point === "unsaved") assert.equal(JSON.parse(readFileSync(join(dir, "refused"), "utf8")).why, "unsaved")
  const world = new AgentsWorld({ root: dir, script, transcripts: true })
  try {
    const told = () => world.prompts.filter((prompt) => prompt.conversation === fin)
    await until(`${label}: the Fin to be told`, () => told().length > 0)
    await pause(500)
    const briefs = told().filter((prompt) => prompt.text.includes(BRIEF))
    const continued = told().filter((prompt) => prompt.text.startsWith(CONTINUE))
    if (point === "heard") {
      assert.deepEqual([briefs.length, continued.length], [0, 1], `${label}: a Fin whose transcript has its brief is continued`)
      return
    }
    assert.equal(briefs.length, 1, `${label}: the brief went once`)
    assert.equal(briefs[0]!.text.includes(BRIEF_AGAIN), point === "submitted", `${label}: framed as sent again only when it may have reached the Fin`)
    assert.equal(continued.length, 0, `${label}: no bare "Continue" to a Fin that may never have had its brief`)
  } finally {
    await world.close()
  }
}

async function main(): Promise<void> {
  // A transcript holds a prompt under the attempt's id where the harness keeps it, or by a line of its words.
  const said = [{ type: "user" as const, text: "[mako · notes]\n\nYou're fin:worker, a Fin", messageId: "attempt-1" }]
  assert.equal(transcriptHolds(said, { attemptId: "attempt-1", marker: "" }), true)
  assert.equal(transcriptHolds(said, { attemptId: "attempt-2", marker: "You're fin:worker, a Fin" }), true)
  assert.equal(transcriptHolds(said, { attemptId: "attempt-2", marker: "You're fin:other, a Fin" }), false)
  assert.equal(transcriptHolds([{ type: "text", text: "You're fin:worker, a Fin" }], { marker: "You're fin:worker, a Fin" }), false, "only a user message counts")
  const root = mkdtempSync(join(tmpdir(), "mako-handoff-"))
  const failures: string[] = []
  try {
    for (const point of POINTS)
      await Promise.all(HARNESSES.map(async (harness) => {
        const dir = join(root, `${point}-${harness}`)
        try {
          const killed = await run(dir, harness, point)
          assert.equal(killed.signal, "SIGKILL", `${point} on ${harness}: ${killed.stderr.slice(-800)}`)
          await check(dir, harness, point)
        } catch (error) {
          failures.push(`${point} on ${harness}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }))
  } finally {
    if (!failures.length) rmSync(root, { recursive: true, force: true })
  }
  if (failures.length) {
    console.error(`${failures.length} failed; their stores are in ${root}:\n${failures.join("\n")}`)
    process.exit(1)
  }
  console.log("handoff: a brief the journal couldn't record as sent went once after SIGKILL; one recorded but maybe unsent went again as such; one its transcript showed was continued; on all six harnesses")
}

if (process.argv[2] === "--host") await host(process.argv[3]!, process.argv[4]!, POINTS.find((point) => point === process.argv[5]) ?? "unsaved")
else await main()
