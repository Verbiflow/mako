import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentsWorld } from "./lib/agents-world"

/**
 * A digest holding a Fin's report and a queued start's "It didn't start", with a real SIGKILL just before or just after
 * the conversation takes it (`npm run test:held-notice-crash`). The notice has no report row, so the request that
 * carries it is named on its queue row: the next host finds that request, and the Apex hears it once.
 */
const REPORTED = "the Fin's own report"
const UNREADABLE = "Mako couldn't read what was queued for it"

async function until(check: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!check()) {
    assert.ok(Date.now() < deadline, `timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A host whose first digest holding both dies at `when`, around its submit. */
async function host(root: string, when: string): Promise<void> {
  const w = new AgentsWorld({ root, script: (turn) => (turn.text.includes("You're fin:") ? REPORTED : "Noted.") })
  const apex = await w.apex("claude", "full")
  writeFileSync(join(root, "apex"), apex.conversation)
  w.say(apex.conversation, "Warm up.")
  await w.settle()
  // The digest holding both: new in the queue, or one waiting there that took the other in.
  const dying = <A extends unknown[], R>(call: (...args: A) => R, text: (args: A) => string) => (...args: A): R => {
    const said = text(args)
    const both = said.includes(REPORTED) && said.includes(UNREADABLE)
    if (both && when === "before") process.kill(process.pid, "SIGKILL")
    const taken = call(...args)
    if (both) process.kill(process.pid, "SIGKILL")
    return taken
  }
  w.live.submit = dying(w.live.submit.bind(w.live), (args) => args[2])
  w.live.rewriteWaiting = dying(w.live.rewriteWaiting.bind(w.live), (args) => args[2])
  const placed = w.store.journalPlacement(apex.conversation)!
  const lead = { session: placed.session, thread: placed.thread, conversation: apex.conversation }
  w.store.queueSpawn({ op: `start:${placed.session}:old`, tree: placed.thread, at: Date.now(), record: JSON.stringify({ lead, input: { name: "old", brief: "a brief before briefs were objects" }, harness: "claude" }) })
  await w.agents.start(apex.caller, { brief: { objective: "Report once" }, name: "working", clientKey: "working", cwd: root })
  w.agents.resume()
  await until(() => false, "the kill")
}

if (process.argv[2] === "host") await host(process.argv[3]!, process.argv[4]!)
else {
  for (const when of ["before", "after"]) {
    const root = mkdtempSync(join(tmpdir(), "mako-held-notice-"))
    let w: AgentsWorld | undefined
    try {
      const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "host", root, when], { stdio: ["ignore", "ignore", "pipe"] })
      let said = ""
      child.stderr.on("data", (chunk) => (said += chunk))
      const killed = await new Promise<NodeJS.Signals | null>((resolve) => child.once("exit", (_, signal) => resolve(signal)))
      assert.equal(killed, "SIGKILL", said)
      assert.ok(existsSync(join(root, "apex")), said)
      const apex = readFileSync(join(root, "apex"), "utf8")
      w = new AgentsWorld({ root, script: () => "Noted." })
      const world = w
      const told = () => world.prompts.filter((prompt) => prompt.conversation === apex && prompt.text.includes(UNREADABLE)).length
      await until(() => told() > 0, "the next host to deliver the digest")
      await until(() => world.live.snapshot(apex)?.requests.at(-1)?.status === "completed", "its turn to end")
      // Whatever a host holds back for the Apex's next turn goes with this one.
      world.say(apex, "The next turn.")
      await until(() => world.store.queuedSpawns().length === 0, "its row to leave the queue")
      await world.settle()
      assert.equal(told(), 1, `killed ${when} the digest was taken: it's explained once`)
      assert.equal(world.prompts.filter((prompt) => prompt.conversation === apex && prompt.text.startsWith("[mako · from your Fins")).length, 1, "in the one digest that carried the report")
    } finally {
      await w?.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
  console.log("held notice crash: a killed host's digest is one request to the next, so its queued start's notice is heard once")
}
