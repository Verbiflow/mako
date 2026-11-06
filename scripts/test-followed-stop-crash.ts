import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { processIdentityMatches } from "@mako/host/base/process-liveness"
import { PROCESS_READS } from "@mako/host/conversations/agent-runs"
import { AgentsWorld, fakeCatalog } from "./lib/agents-world.ts"

/**
 * A stop a crash cut short (`npm run test:followed-stop-crash`): a host stops a shell-linked run that ignores
 * SIGTERM and is killed itself at once, its kill timer with it. The next host reads the stop it left, holds the
 * run's place before it drains anything, kills the run in its turn once its grace is up, and only then starts the
 * Fin that waited, which nothing overwrites after. And a host that shuts down as a stop reads whether the run is still
 * its process: that read's answer comes to a closed store and signals nothing, and the stop is the next host's.
 */
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const until = async (check: () => boolean | Promise<boolean>, what: string, ms = 15_000) => {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await pause(20)
  }
}
const script = (root: string) => async (turn: { text: string; conversation: string; world: AgentsWorld }) => {
  if (turn.text.includes("You're fin:")) {
    writeFileSync(join(root, "shared.txt"), "next")
    await turn.world.hold(turn.conversation)
  }
  return "ok"
}
/** A stopped run's grace, written out: read from the product, a longer one there would move this test's clock with it. */
const GRACE_MS = 5_000
/** The linked run's process as the first host wrote it down, by pid and start. */
const Identity = z.object({ pid: z.number().int().positive(), startedAt: z.number().optional() })
const live = (identity: { pid: number; startedAt?: number }) => processIdentityMatches({ ...identity, exact: true, signal: new AbortController().signal }).catch(() => false)

if (process.argv[2] === "host") {
  const root = process.argv[3]!
  const fake = fakeCatalog()
  const w = new AgentsWorld({ root, catalog: fake.catalog, finLimit: () => 1, script: script(root) })
  const shell = spawn(process.execPath, ["-e", "const fs=require('node:fs');process.on('SIGTERM',()=>{});const put=()=>{fs.writeFileSync('shared.tmp','linked');fs.renameSync('shared.tmp','shared.txt')};put();console.log('ready');setInterval(put,10)"], { cwd: root, detached: true, stdio: ["ignore", "pipe", "ignore"] })
  await new Promise<void>((resolve) => shell.stdout!.once("data", () => resolve()))
  const identity = await w.agents.runs.processOf(shell.pid!)
  assert.ok(identity)
  writeFileSync(join(root, "linked-process.json"), JSON.stringify(identity))
  const apex = await w.apex("claude", "full")
  const nativeId = randomUUID()
  fake.write({ harness: "claude", nativeId, path: join(root, "linked.jsonl"), cwd: root, startedAt: new Date().toISOString() }, [{ type: "tool", id: "one", name: "Bash", input: "{}", status: "completed" }])
  const linked = await w.agents.link(apex.caller, { harness: "claude", session: nativeId, pid: shell.pid!, name: "linked" })
  assert.ok(!("refused" in linked))
  await until(() => w.agents.diagnostics().running === 1, "the linked run counted")
  const next = await w.agents.start(apex.caller, { name: "next", clientKey: "next", queue: true, cwd: root, brief: { objective: "Edit the shared file" } })
  assert.ok(!("refused" in next) && next.state === "queued")
  await w.agents.stop(apex.caller, { child: "linked" })
  assert.ok(w.agents.runs.isTerminating(linked.child))
  writeFileSync(join(root, "stopped-at.json"), JSON.stringify(w.store.edges().of(linked.child!)!.run!.stopping!.at))
  process.kill(process.pid, "SIGKILL")
} else {
  const root = mkdtempSync(join(tmpdir(), "mako-followed-stop-crash-"))
  let w: AgentsWorld | undefined
  try {
    const host = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "host", root], { stdio: ["ignore", "ignore", "pipe"] })
    let said = ""
    host.stderr.on("data", (data) => (said += data))
    const signal = await new Promise<NodeJS.Signals | null>((resolve) => host.once("exit", (_code, signal) => resolve(signal)))
    assert.equal(signal, "SIGKILL", said)
    const identity = Identity.parse(JSON.parse(readFileSync(join(root, "linked-process.json"), "utf8")))
    assert.ok(await live(identity), "the linked run outlived the host that stopped it")
    // The next host's clock, held a moment short of the run's grace and then moved to it: the kill comes at the grace,
    // whatever the runner's own clock did. The run never ends by itself: left running, it outlives the hang guard.
    const graceEnds = z.number().parse(JSON.parse(readFileSync(join(root, "stopped-at.json"), "utf8"))) + GRACE_MS
    let clock: number | undefined = graceEnds - 1
    w = new AgentsWorld({ root, catalog: fakeCatalog().catalog, finLimit: () => 1, script: script(root), now: () => clock ?? Date.now() })
    const started = () => w!.prompts.some((prompt) => prompt.text.includes("You're fin:next,"))
    await pause(500)
    assert.equal(started(), false, "the next host holds the stopped run's place while its process runs")
    assert.equal(readFileSync(join(root, "shared.txt"), "utf8"), "linked")
    assert.ok(await live(identity), "and its grace isn't up")
    clock = graceEnds
    await until(async () => !(await live(identity)), "the next host to kill the run the moment its grace is up", 30 * GRACE_MS)
    clock = undefined
    await until(started, "next to start once the run was gone")
    await pause(100)
    assert.equal(readFileSync(join(root, "shared.txt"), "utf8"), "next", "and nothing overwrote its file after")
    console.log("followed stop crash: the next host held the place, killed the run in its turn, then started the Fin behind it")
  } finally {
    if (existsSync(join(root, "linked-process.json"))) {
      const identity = Identity.parse(JSON.parse(readFileSync(join(root, "linked-process.json"), "utf8")))
      if (await live(identity)) process.kill(-identity.pid, "SIGKILL")
    }
    await w?.close()
    rmSync(root, { recursive: true, force: true })
  }
  await shutDownDuringStop("aborted")
  await shutDownDuringStop("same process")
  console.log("followed stop shutdown: a read that ended after the host did wrote nothing and signalled nothing")
}

/** `answer`: what the identity read under way comes back with once the host has shut down. */
async function shutDownDuringStop(answer: "aborted" | "same process"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "mako-stop-shutdown-"))
  const fake = fakeCatalog()
  const failures: string[] = []
  const failed = (error: Error) => void failures.push(String(error))
  process.on("unhandledRejection", failed)
  const shell = spawn(process.execPath, ["-e", "console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "pipe", "ignore"] })
  await new Promise((resolve) => shell.stdout.once("data", resolve))
  let armed = false
  let read: (() => void) | undefined
  const world = new AgentsWorld({
    root,
    catalog: fake.catalog,
    script: () => "ok",
    processes: {
      ...PROCESS_READS,
      matches: (pid, at, signal) => {
        if (!armed) return PROCESS_READS.matches!(pid, at, signal)
        return new Promise<boolean>((resolve, reject) => {
          read = () => (answer === "same process" ? resolve(true) : reject(new Error("aborted")))
          if (answer === "aborted") signal.addEventListener("abort", read, { once: true })
        })
      },
    },
  })
  try {
    const apex = await world.apex("claude", "full")
    const nativeId = randomUUID()
    fake.write({ harness: "claude", nativeId, path: join(root, "linked.jsonl"), cwd: root, startedAt: new Date().toISOString() }, [{ type: "tool", id: "one", name: "Bash", input: "{}", status: "completed" }])
    const linked = await world.agents.link(apex.caller, { harness: "claude", session: nativeId, pid: shell.pid!, name: "linked" })
    assert.ok(!("refused" in linked), JSON.stringify(linked))
    armed = true
    await world.agents.stop(apex.caller, { child: "linked" })
    await until(() => read !== undefined, "the stop to read the run's process")
    await world.close()
    read!()
    await pause(50)
    assert.deepEqual(failures, [], `a stop's read that ends after shutdown leaves the closed store alone (${answer})`)
    assert.equal(shell.signalCode, null, `and signals nothing: the stop is the next host's (${answer})`)
    assert.ok(process.kill(shell.pid!, 0), "the run still runs")
  } finally {
    process.off("unhandledRejection", failed)
    shell.kill("SIGKILL")
    rmSync(root, { recursive: true, force: true })
  }
}
