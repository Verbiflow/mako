import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentsWorld, HARNESSES } from "./lib/agents-world.ts"

/*
 * A pull request's note through a real SIGKILL (`npm run test:fin-pull-waits`), on each of the six harnesses: its claim
 * delivered to the journal, its attempt prepared, nothing handed to the harness. A note proven unsent is Mako's, so the
 * next host sends it, once, by itself. A Stop's mark on it stays, and a wait a newer report withdrew stays withdrawn.
 */
const CASES = ["prepared", "stopped", "withdrawn"] as const
type Case = (typeof CASES)[number]
const NOTE = "Mako: PR acme/app#7"
const MERGED = { state: "merged" as const, url: "https://git.example.com/acme/app/pull/7", checks: [], reviews: [] }

async function until(what: string, done: () => boolean, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

/** The first host: a Fin waits on a merged pull request, and the host dies with the note prepared and its receipt written. */
async function dying(root: string, harness: string, which: Case): Promise<void> {
  mkdirSync(root, { recursive: true })
  let fin = ""
  let ready = false
  let armed = false
  const world: AgentsWorld = new AgentsWorld({
    root,
    readPull: async () => MERGED,
    refusePrompt: async (id) => {
      if (!armed || id !== fin) return undefined
      await until("the note's receipt", () => world.store.undeliveredPullWakes().length === 0)
      const note = world.live.snapshot(fin)?.requests.find((request) => request.text.startsWith(NOTE))
      assert.equal(note?.nativeDelivery?.evidence.kind, "prepared", "killed before its handoff")
      if (which === "stopped") await world.live.cancel(fin)
      if (which === "withdrawn") await world.agents.report(world.caller(fin), { status: "progress", summary: "Moved on.", clientKey: "moved-on" })
      writeFileSync(join(root, "killed"), "")
      process.kill(process.pid, "SIGKILL")
      return undefined
    },
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) {
        fin = turn.conversation
        await turn.world.agents.report(turn.caller, { status: "progress", summary: "Waiting on #7.", waitingOn: [{ kind: "pull-request", ref: "acme/app#7", until: "merge" }], clientKey: "wait" })
        ready = true
      }
      return "ok"
    },
  })
  const apex = await world.apex("claude", "full")
  const started = await world.agents.start(apex.caller, { harness, brief: { objective: "Land the pull request" }, name: "worker", clientKey: "worker", cwd: world.root })
  assert.ok(!("refused" in started), JSON.stringify(started))
  await until("its turn to end", () => ready && world.live.session(fin)?.status === "ready")
  writeFileSync(join(root, "fin"), fin)
  armed = true
  await world.agents.pulls.tick()
  await new Promise(() => {})
}

async function next(root: string, harness: string, which: Case): Promise<void> {
  const label = `${which} on ${harness}`
  assert.ok(existsSync(join(root, "killed")), `${label}: the host died where it was meant to`)
  const fin = readFileSync(join(root, "fin"), "utf8")
  const heard = join(root, "heard")
  const world = new AgentsWorld({ root, readPull: async () => MERGED, script: async () => "ok", heard: (line) => { if (line.text.includes(NOTE)) appendFileSync(heard, `${line.conversation}\n`) } })
  const sent = () => (existsSync(heard) ? readFileSync(heard, "utf8").split("\n").filter(Boolean) : [])
  const note = () => world.live.snapshot(fin)?.requests.find((request) => request.text.startsWith(NOTE))
  try {
    if (which === "prepared") {
      await until(`${label}: the note to go by itself`, () => sent().length > 0)
      await new Promise((resolve) => setTimeout(resolve, 200))
      assert.deepEqual(sent(), [fin], `${label}: once, to the Fin`)
      return
    }
    await world.settle(300)
    world.live.wakeDue(Date.now() + 86_400_000)
    await world.agents.pulls.tick()
    await world.settle(300)
    assert.deepEqual(sent(), [], `${label}: nothing goes`)
    if (which === "stopped") assert.deepEqual([note()?.status, note()?.pause], ["held", "stop"], `${label}: the Stop's mark stands`)
    else assert.equal(note()?.status, "canceled", `${label}: a withdrawn wait's note is canceled`)
    assert.equal(world.store.undeliveredPullWakes().length, 0, `${label}: no claim left`)
    assert.deepEqual(world.agents.pulls.keys(), [], `${label}: nothing to watch`)
  } finally {
    await world.close()
  }
}

if (process.argv[2] === "--host") await dying(process.argv[3]!, process.argv[4]!, CASES.find((each) => each === process.argv[5])!)
else {
  const root = mkdtempSync(join(tmpdir(), "mako-pull-wake-crash-"))
  const failures: string[] = []
  try {
    for (const which of CASES)
      for (const harness of HARNESSES) {
        const dir = join(root, `${which}-${harness}`)
        try {
          const killed = spawnSync(process.execPath, ["--import", "tsx", import.meta.filename, "--host", dir, harness, which], { stdio: ["ignore", "ignore", "pipe"], timeout: 30_000, encoding: "utf8" })
          assert.equal(killed.signal, "SIGKILL", `${which} on ${harness}: ${killed.stderr.slice(-800)}`)
          await next(dir, harness, which)
        } catch (error) {
          failures.push(`${which} on ${harness}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
  if (failures.length) {
    console.error(`${failures.length} failed:\n${failures.join("\n")}`)
    process.exit(1)
  }
  console.log("pull wake crash: a note proven unsent went by itself, once; a Stop's mark and a withdrawn wait stood; on all six harnesses")
}
