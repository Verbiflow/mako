import assert from "node:assert/strict"
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { RecordBundleSchema } from "@mako/protocol/records"
import { NativeStores } from "../dist/read-only-sqlite.js"
import { RecordStore } from "../dist/record-store.js"
import { GrokProvider } from "../dist/providers/grok.js"
import { grokFork } from "../dist/providers/grok-fork.js"
import { withStreams } from "../dist/record-streams.js"

/**
 * A Grok Thread that went to a machine and comes back (production, 2026-10-23). Grok's `session/load` on the machine
 * writes whole files again (summary.json, prompt_context.json, announcement_state.json): the device's copy holds
 * versions Mako captured of them, so the session is a fast-forward and restores in place, the same session. A copy
 * that went on here too forks, its launches' streams (Mako's own files, no fork rule's) written beside it as shared.
 */

const ID = "01a16b06-7f34-75b2-9251-8a17acd1e062"
const CWD = "/Users/someone/project/worktree"
const stores = new NativeStores(false)
const folder = (home) => join(home, ".grok", "sessions", encodeURIComponent(CWD), ID)
const streams = (home) => join(home, ".mako", "records", "streams")
const update = (n, update) => JSON.stringify({ timestamp: 1792796950 + n, method: "session/update", params: { sessionId: ID, update, _meta: { eventId: `${ID}-${n}` } } })
const summary = (attempt, at) => JSON.stringify({ info: { id: ID, cwd: CWD }, attempt_id: attempt, created_at: "2026-10-23T23:09:10Z", updated_at: at, generated_title: "Move proof" }, null, 2)

async function capture(store, home, launches) {
  const records = await new GrokProvider(home).records(join(folder(home), "updates.jsonl"))
  return store.capture({ harness: "grok", nativeId: ID, home, records: withStreams(records, streams(home), launches.map((launch) => join(streams(home), "grok", `${ID}@${launch}.jsonl`))) })
}
async function cross(from, to) {
  const bundle = RecordBundleSchema.parse(JSON.parse(JSON.stringify(from.exportSession("grok", ID, to.holdings("grok", ID)))))
  await to.importSession(bundle, async function* (hashes) {
    for (const hash of hashes) yield { hash, chunk: await from.readChunk(hash) }
  })
}
async function stream(home, launch) {
  await mkdir(join(streams(home), "grok"), { recursive: true })
  await writeFile(join(streams(home), "grok", `${ID}@${launch}.jsonl`), `${JSON.stringify({ capture: 1, harness: "grok" })}\n${JSON.stringify({ ended: true })}\n`)
}

for (const wentOnHere of [false, true]) {
  const root = await mkdtemp(join(tmpdir(), "mako-record-return-rewrites-"))
  const device = join(root, "device"), machineHome = join(root, "machine")
  const [laptop, cloud, machine] = ["laptop", "cloud", "machine"].map((name) => new RecordStore(join(root, `${name}-records`), stores))
  try {
    await mkdir(folder(device), { recursive: true })
    await writeFile(join(folder(device), "updates.jsonl"), [
      update(1, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Run the busy command" } }),
      update(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BUSY-DONE" } }),
      update(3, { sessionUpdate: "hook_execution", event_name: "stop", runs: [] }),
    ].join("\n") + "\n")
    await writeFile(join(folder(device), "summary.json"), summary("at1.device", "2026-10-23T23:09:50Z"))
    await writeFile(join(folder(device), "prompt_context.json"), JSON.stringify({ agents_md_files: [{ content: "x".repeat(500) }] }))
    await stream(device, "device-launch")
    await capture(laptop, device, ["device-launch"])
    await cross(laptop, cloud)
    await cross(cloud, machine)
    assert.equal((await machine.restore({ harness: "grok", nativeId: ID, home: machineHome })).written, true, "the machine takes the session")
    if (wentOnHere) await appendFile(join(folder(device), "updates.jsonl"), `${update(9, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "said here after the move" } })}\n`)

    // Grok's load on the machine: an update appended, whole files written again, shorter and longer; a launch's stream.
    await appendFile(join(folder(machineHome), "updates.jsonl"), `${update(4, { sessionUpdate: "background_tasks", tasks: [] })}\n`)
    await writeFile(join(folder(machineHome), "summary.json"), summary("at1.machine", "2026-10-23T23:10:05Z"))
    await writeFile(join(folder(machineHome), "prompt_context.json"), JSON.stringify({ agents_md_files: [] }))
    await stream(machineHome, "machine-launch")
    await capture(machine, machineHome, ["device-launch", "machine-launch"])
    await cross(machine, cloud)
    await cross(cloud, laptop)

    const dry = await laptop.restore({ harness: "grok", nativeId: ID, home: device, fork: grokFork, dryRun: true })
    if (!wentOnHere) {
      assert.deepEqual(dry.diverged, [], "files Grok writes whole again, held here as versions Mako captured, are behind, not gone on")
      assert.equal(dry.fork, undefined, "the same session comes back, not a fork")
      const report = await laptop.restore({ harness: "grok", nativeId: ID, home: device, fork: grokFork })
      assert.equal(report.written, true)
      assert.equal(JSON.parse(await readFile(join(folder(device), "summary.json"), "utf8")).attempt_id, "at1.machine", "the machine's summary replaces the device's")
      assert.match(await readFile(join(folder(device), "updates.jsonl"), "utf8"), /background_tasks/, "the machine's update is appended")
      assert.ok((await readFile(join(streams(device), "grok", `${ID}@machine-launch.jsonl`), "utf8")).includes("ended"), "the machine's stream comes too")
    } else {
      assert.deepEqual(dry.diverged, [], `a copy that went on here forks, streams and all: ${JSON.stringify(dry.diverged)}`)
      assert.ok(dry.fork && !dry.fork.diverged.length, "the arriving version is a fork of Grok's own")
    }
  } finally {
    await Promise.all([laptop.close(), cloud.close(), machine.close()])
    await rm(root, { recursive: true, force: true })
  }
}

// A device that captured the session again once its own stream was pruned (the store holds it whole, the file goes):
// that capture's layout has no streams root, yet the machine's stream comes back with the session. It's written into
// this host's streams folder, named by the restore as a receive names the harness's own roots (local, 2026-10-24:
// "No folder is known for the record root mako-streams", and the Thread stayed in the cloud).
{
  const root = await mkdtemp(join(tmpdir(), "mako-record-return-pruned-"))
  const device = join(root, "device"), machineHome = join(root, "machine")
  const [laptop, cloud, machine] = ["laptop", "cloud", "machine"].map((name) => new RecordStore(join(root, `${name}-records`), stores))
  try {
    await mkdir(folder(device), { recursive: true })
    await writeFile(join(folder(device), "updates.jsonl"), `${update(1, { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Run the busy command" } })}\n`)
    await stream(device, "device-launch")
    await capture(laptop, device, ["device-launch"])
    await cross(laptop, cloud)
    await cross(cloud, machine)
    assert.equal((await machine.restore({ harness: "grok", nativeId: ID, home: machineHome })).written, true, "the machine takes the session")
    await rm(join(streams(device), "grok", `${ID}@device-launch.jsonl`))
    await capture(laptop, device, [])
    assert.deepEqual(laptop.rootNames("grok", ID).sort(), ["grok", "mako-streams"], "a root its units still name stays among the session's roots")

    await appendFile(join(folder(machineHome), "updates.jsonl"), `${update(2, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "BUSY-DONE" } })}\n`)
    await stream(machineHome, "machine-launch")
    await capture(machine, machineHome, ["device-launch", "machine-launch"])
    await cross(machine, cloud)
    await cross(cloud, laptop)
    // As a receive names them: the harness's roots here, and this host's streams folder.
    const roots = [{ name: "grok", path: join(device, ".grok") }, { name: "mako-streams", path: streams(device) }]
    const report = await laptop.restore({ harness: "grok", nativeId: ID, home: device, fork: grokFork, roots })
    assert.equal(report.written, true, JSON.stringify(report.diverged))
    assert.match(await readFile(join(folder(device), "updates.jsonl"), "utf8"), /BUSY-DONE/, "the machine's turn comes back")
    assert.ok((await readFile(join(streams(device), "grok", `${ID}@machine-launch.jsonl`), "utf8")).includes("ended"), "the machine's stream comes into this host's streams folder")
  } finally {
    await Promise.all([laptop.close(), cloud.close(), machine.close()])
    await rm(root, { recursive: true, force: true })
  }
}
console.log("PASS: a Grok session Grok rewrote on the machine comes back as itself; one that went on here too forks; one whose stream was pruned here still takes the machine's")
