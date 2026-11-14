import "./lib/scratch-git.mjs"
import assert from "node:assert/strict"
import { fork, execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { NativeAgentSchema } from "@mako/host/contracts/native-agents"

const snapshot = (id, generation = 1, revision = 10, agents = []) => ({
  session: { id, harness: "codex", cwd: "/fixture", status: "ready", connection: "connected", modes: [], currentMode: null, configOptions: [] },
  createdAt: 1, epoch: `g${generation}.roottest.${generation}`, revision,
  base: null, blocks: [], requests: [], permissions: [], nativeAgents: { agents, limited: false },
})
const summary = (value) => ({ session: value.session, epoch: value.epoch, revision: value.revision, createdAt: value.createdAt })

// The existing fixture's public command protocol, with an awaited, bounded child lifetime.
// rosterWindow.close() does not expose its child's exit, so this test owns the fork directly.
const child = fork(fileURLToPath(new URL("./lib/roster-window.ts", import.meta.url)), ["--window"], {
  detached: true, execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"],
  env: { ...process.env, TSX_TSCONFIG_PATH: "tsconfig.app.json" },
})
let generation, launchFailure
child.on("error", (error) => { launchFailure = error })
try { generation = execFileSync("ps", ["-p", String(child.pid), "-o", "lstart="], { encoding: "utf8" }).trim() }
catch (error) { launchFailure = error }
console.log(JSON.stringify({ event: "renderer-launched", pid: child.pid, group: child.pid, generation, at: new Date().toISOString() }))
child.once("exit", (code, signal) => console.log(JSON.stringify({ event: "renderer-exit", pid: child.pid, generation, code, signal })))
let stderr = "", closed = false
child.stderr.on("data", (text) => { stderr = (stderr + text.toString()).slice(-8000) })
const exited = new Promise((resolve) => child.once("close", (code, signal) => {
  closed = true
  resolve({ code, signal })
}))
const overall = setTimeout(() => child.kill("SIGKILL"), 60_000)
function ask(command) {
  assert.ok(!closed && child.connected, "the owned renderer is still connected")
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error, state) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.removeListener("message", answer)
      child.removeListener("exit", end)
      child.removeListener("error", fail)
      if (error) reject(error)
      else resolve(state)
    }
    const answer = (state) => finish(null, state)
    const end = (code, signal) => finish(new Error(`Renderer exited ${code}/${signal}: ${stderr}`))
    const fail = (error) => finish(error)
    const timer = setTimeout(() => finish(new Error(`Renderer did not answer ${command.kind}: ${stderr}`)), 10_000)
    child.once("message", answer)
    child.once("exit", end)
    child.once("error", fail)
    child.send(command, (error) => { if (error) finish(error) })
  })
}
async function stop() {
  const wait = (milliseconds) => {
    let timer
    return Promise.race([exited, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Owned renderer did not exit")), milliseconds)
    })]).finally(() => clearTimeout(timer))
  }
  clearTimeout(overall)
  if (!closed && child.exitCode === null && child.signalCode === null) {
    if (!generation) child.kill("SIGTERM")
    else {
    const current = execFileSync("ps", ["-p", String(child.pid), "-o", "lstart="], { encoding: "utf8" }).trim()
    assert.equal(current, generation, "cleanup still owns the launched process generation")
    process.kill(-child.pid, "SIGTERM")
    }
  }
  try { return await wait(2000) }
  catch {
    if (!closed) child.kill("SIGKILL")
    return await wait(1000)
  }
}
const readOf = (state, id) => {
  const read = state.reads.find((read) => read.conversation === id)
  assert.ok(read, `a read of ${id} is outstanding`)
  return read
}
const answer = async (read, value) => {
  console.log(JSON.stringify({ read: read.number, requestedID: read.conversation, returnedID: value.session.id, epoch: value.epoch, revision: value.revision }))
  return ask({ kind: "reply", read: read.number, snapshot: value })
}
const idle = (state) => assert.equal(state.reads.length, 0, "all requested snapshots have settled")
let failed = false, failure
try {
  if (launchFailure) throw launchFailure
  for (const retired of [false, true]) {
    const a = snapshot(`asked-${retired}`), b = snapshot(`canonical-${retired}`, 5)
    await ask({ kind: "init", snapshot: a, listed: true })
    const read = readOf(await ask({ kind: "open" }), a.session.id)
    const listed = await ask({ kind: "init", snapshot: b, listed: true })
    assert.equal(listed.held?.hydrated, false)
    if (retired) assert.equal((await ask({ kind: "unlist" })).held, undefined)
    console.log(JSON.stringify({ case: "canonical", retiredBeforeAnswer: retired }))
    const state = await answer(read, b)
    if (retired) assert.equal(state.held, undefined, "a late reply resurrected an unlisted conversation")
    else {
      assert.equal(state.held?.epoch, b.epoch, "a legitimate newer canonical upgrade is admitted")
      assert.equal(state.held?.hydrated, true, "the previously listed canonical target is hydrated")
    }
    idle(state)
  }

  const same = snapshot("same-id")
  await ask({ kind: "init", snapshot: same, listed: true })
  const sameRead = readOf(await ask({ kind: "open" }), same.session.id)
  await ask({ kind: "unlist" })
  const absent = await answer(sameRead, same)
  assert.equal(absent.held, undefined, "same-ID retirement still refuses the old read")
  idle(absent)

  const relisted = snapshot("relisted", 5)
  await ask({ kind: "init", snapshot: relisted, listed: true })
  const retiredRead = readOf(await ask({ kind: "open" }), relisted.session.id)
  await ask({ kind: "unlist" })
  await ask({ kind: "list", summary: summary(relisted) })
  const row = await answer(retiredRead, relisted)
  assert.equal(row.held?.hydrated, false, "relisting does not authorize an old hydration")
  const freshRead = readOf(await ask({ kind: "open" }), relisted.session.id)
  const restored = await answer(freshRead, relisted)
  assert.equal(restored.held?.hydrated, true, "an intentional new read restores the relisted row")
  idle(restored)

  // Review of focused120: a reconnect listing does not retag retained content as the listing's newer epoch.
  const content = snapshot("listing-content", 5), listing = snapshot("listing-content", 6, 2)
  await ask({ kind: "init", snapshot: content })
  const listedContent = await ask({ kind: "list", summary: summary(listing) })
  assert.equal(listedContent.held?.epoch, content.epoch, "listing authority does not retag the held content epoch")
  assert.equal(listedContent.held?.hydrated, false, "a reconnect listing requires a fresh hydration")
  const listedRead = readOf(await ask({ kind: "open" }), listing.session.id)
  const listedFresh = await answer(listedRead, listing)
  assert.equal(listedFresh.held?.epoch, listing.epoch, "fresh content establishes the new epoch")
  assert.equal(listedFresh.held?.hydrated, true)
  idle(listedFresh)

  const old = snapshot("epoch", 5), current = snapshot("epoch", 6, 2)
  await ask({ kind: "init", snapshot: old, listed: true })
  const oldRead = readOf(await ask({ kind: "open" }), old.session.id)
  const parallel = await ask({ kind: "read" })
  const newerRead = parallel.reads.find((read) => read.number !== oldRead.number)
  assert.ok(newerRead)
  await answer(newerRead, current)
  const overtaken = await answer(oldRead, old)
  assert.equal(overtaken.held?.epoch, current.epoch, "an old epoch cannot replace a newer snapshot already taken")
  assert.equal(overtaken.held?.hydrated, true)
  idle(overtaken)
  await ask({ kind: "unload" })
  const recovery = readOf(await ask({ kind: "open" }), current.session.id)
  const recovered = await answer(recovery, current)
  assert.equal(recovered.held?.hydrated, true, "a fresh current-epoch read still completes")
  idle(recovered)

  // B's retirement must hold while several A reads and a B read are outstanding,
  // not only when settling A clears the last global unlisting record.
  const a = snapshot("concurrent-a"), b = snapshot("concurrent-b", 5)
  await ask({ kind: "init", snapshot: a, listed: true })
  const hydration = readOf(await ask({ kind: "open" }), a.session.id)
  const reading = await ask({ kind: "read" })
  const second = reading.reads.find((read) => read.conversation === a.session.id && read.number !== hydration.number)
  assert.ok(second)
  await ask({ kind: "init", snapshot: b, listed: true })
  const own = readOf(await ask({ kind: "open" }), b.session.id)
  await ask({ kind: "unlist" })
  assert.equal((await answer(hydration, b)).held, undefined)
  assert.equal((await answer(second, b)).held, undefined)
  const concurrent = await answer(own, b)
  assert.equal(concurrent.held, undefined, "no outstanding owner can resurrect B")
  idle(concurrent)

  const worker = NativeAgentSchema.parse({ bindingId: "binding", provider: "codex", nativeId: "ordinary-worker", title: "Guardian", observedAt: 1,
    state: { kind: "working" }, child: { thread: "11111111-1111-4111-8111-111111111111", origin: "started", name: "Guardian", state: { kind: "working" } } })
  const unknown = NativeAgentSchema.parse({ bindingId: "binding", provider: "codex", nativeId: "unknown-origin", title: "Unknown origin", observedAt: 1,
    state: { kind: "unknown", reason: "No origin was recorded" } })
  const ordinary = snapshot("new-ordinary-worker", 5, 10, [worker, unknown])
  await ask({ kind: "init", snapshot: ordinary, listed: true })
  await ask({ kind: "unlist" })
  const ordinaryRead = readOf(await ask({ kind: "open" }), ordinary.session.id)
  const kept = await answer(ordinaryRead, ordinary)
  assert.deepEqual(kept.held?.roster, ordinary.nativeAgents, "ordinary workers and unknown-origin work remain readable")
  idle(kept)
  console.log("Canonical hydration: retirement, legitimate upgrade, relisting, epoch recovery, concurrent owners, ordinary and unknown work")
} catch (error) {
  failed = true
  failure = error
} finally {
  console.log(JSON.stringify({ event: "test-outcome", status: failed ? "failed" : "passed", ...(failed && { error: failure instanceof Error ? failure.stack : String(failure) }) }))
  try {
    console.log(JSON.stringify({ childExit: await stop() }))
    const members = execFileSync("ps", ["-axo", "pid=,pgid="], { encoding: "utf8" }).trim().split("\n")
      .filter((line) => Number(line.trim().split(/\s+/)[1]) === child.pid)
    assert.deepEqual(members, [], "the owned renderer process group has exited")
    console.log(JSON.stringify({ event: "renderer-cleanup", pid: child.pid, generation, groupEmpty: true }))
  }
  catch (error) {
    if (failed) console.error("Cleanup also failed:", error)
    else { failed = true; failure = error }
  }
}
if (failed) throw failure
