import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mock } from "node:test"
import { followHostLog } from "@mako/host/base/host-log"
import { LiveJournal } from "@mako/host/conversations/live-journal"
import { AgentsWorld, HARNESSES, type Heard, type Script } from "./lib/agents-world.ts"

/**
 * A prompt reaches its harness only once its journal holds it as sent (`npm run test:handoff`): `handOff`, every
 * driver's last step before its transport call. On each of the six harnesses, a host whose journal turns read-only at
 * the moment a Fin's brief is written as submitted, as a full disk or a lost volume does, sends nothing, and is killed
 * there with SIGKILL. The next host reads the brief as never sent, so it goes once, whole: never twice, and never
 * as "Continue where you left off" to a Fin that never had it.
 */
const BRIEF = "You're fin:worker"
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(10)
  }
}

const script: Script = async () => "Done."

/** The host that dies: its journal goes read-only at the brief's handoff, and it's killed once the handoff is refused. */
async function host(dir: string, harness: string): Promise<void> {
  mkdirSync(dir, { recursive: true })
  // A brief its harness took is killed at too, as the transport has it: the next host must not send it again.
  const heard = (line: Heard) => {
    appendFileSync(join(dir, "heard.ndjson"), `${JSON.stringify(line)}\n`)
    if (line.text.includes(BRIEF)) process.kill(process.pid, "SIGKILL")
  }
  let readOnly = false
  const commit = LiveJournal.prototype.commit
  mock.method(LiveJournal.prototype, "commit", function (this: LiveJournal, ...args: Parameters<LiveJournal["commit"]>) {
    if (args[0].requests.some((request) => request.text.includes(BRIEF) && request.nativeDelivery?.evidence.kind === "submitted")) readOnly = true
    if (readOnly) throw Object.assign(new Error("attempt to write a readonly database"), { code: "ERR_SQLITE_ERROR", errcode: 8 })
    return commit.apply(this, args)
  })
  followHostLog((line) => {
    if (line.message !== "a message went no further than its handoff") return
    writeFileSync(join(dir, "refused"), JSON.stringify(line.fields ?? {}))
    process.kill(process.pid, "SIGKILL")
  })
  const world = new AgentsWorld({ root: dir, script, heard })
  const apex = await world.apex("cursor", "full")
  const started = await world.agents.start(apex.caller, { brief: { objective: "Review the sidebar." }, harness, name: "worker", clientKey: "worker", cwd: dir })
  assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
  writeFileSync(join(dir, "fin"), started.conversation!)
  await new Promise(() => {})
}

function run(dir: string, harness: string): Promise<{ signal: NodeJS.Signals | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--host", dir, harness], { stdio: ["ignore", "ignore", "pipe"] })
    let stderr = ""
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString() })
    const timer = setTimeout(() => child.kill("SIGKILL"), 60_000)
    child.on("exit", (_code, signal) => {
      clearTimeout(timer)
      resolve({ signal, stderr })
    })
  })
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mako-handoff-"))
  const failures: string[] = []
  try {
    await Promise.all(HARNESSES.map(async (harness) => {
      const dir = join(root, harness)
      try {
        const killed = await run(dir, harness)
        assert.equal(killed.signal, "SIGKILL", `${harness}: ${killed.stderr.slice(-800)}`)
        const before = existsSync(join(dir, "heard.ndjson")) ? readFileSync(join(dir, "heard.ndjson"), "utf8").split("\n").filter(Boolean).map((line): Heard => JSON.parse(line)) : []
        assert.equal(before.filter((line) => line.text.includes(BRIEF)).length, 0, `${harness}: nothing reached the harness while the journal couldn't say it was sent`)
        assert.equal(JSON.parse(readFileSync(join(dir, "refused"), "utf8")).why, "unsaved")
        const fin = readFileSync(join(dir, "fin"), "utf8")
        const world = new AgentsWorld({ root: dir, script })
        try {
          const told = () => world.prompts.filter((prompt) => prompt.conversation === fin)
          await until(`${harness}: the brief to go`, () => told().some((prompt) => prompt.text.includes(BRIEF)))
          await pause(500)
          assert.equal(told().filter((prompt) => prompt.text.includes(BRIEF)).length, 1, `${harness}: the brief went once`)
          assert.ok(!told().some((prompt) => prompt.text.startsWith("Continue where you left off")), `${harness}: no "Continue" to a Fin that never had its brief`)
        } finally {
          await world.close()
        }
      } catch (error) {
        failures.push(`${harness}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }))
  } finally {
    if (!failures.length) rmSync(root, { recursive: true, force: true })
  }
  if (failures.length) {
    console.error(`${failures.length} failed; their stores are in ${root}:\n${failures.join("\n")}`)
    process.exit(1)
  }
  console.log("handoff: a brief the journal couldn't record as sent went nowhere, and after SIGKILL went once, on all six harnesses")
}

if (process.argv[2] === "--host") await host(process.argv[3]!, process.argv[4]!)
else await main()
