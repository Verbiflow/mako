import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdir, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { manualDevUpdates } from "../electron/dev-updates.mjs"
import { testScratch } from "./lib/test-scratch.mjs"
import { atSize, withMotion } from "./lib/test-window.mjs"

/**
 * A Thread moving to the cloud, against the production components and the
 * fixture desk signed in with the cloud: a Thread in its own worktree offers
 * Move to the cloud from its Local chip; the strip above the composer walks
 * through sending ahead, handing over and resuming; once moved the chip says
 * Cloud, and offers Bring back to this Mac, whose strip walks through packing
 * and bringing it here until the chip says Local again. A busy Thread stays
 * here and says why. This Mac's harnesses weighed against the cloud's before
 * either way: one older than the cloud's offers "Update Codex to 0.164.0, then
 * move" or "Move anyway", its update's progress and failure above the
 * composer; one the cloud can't resume refuses the move in the popover; and a
 * way back waiting on Devin.app's update turns ready as the window is focused
 * again. A way back whose project isn't on this Mac stays in the cloud and
 * offers the folder the project moved to; one left unsettled says whether it
 * waits on the cloud or this Mac, and asks again. Screenshots of each, dark
 * and light, stay in the printed directory.
 */

if (process.versions.electron) {
  void checkWindow().catch(async (error) => {
    console.error(error)
    const { app } = await import("electron")
    app.exit(1)
  })
} else {
  await checkMoveState()
  if (process.argv.includes("--state-only")) process.exit(0)
  const { createServer } = await import("vite")
  const args = process.argv.slice(2)
  const portAt = args.indexOf("--port")
  const port = portAt === -1 ? 0 : Number(args[portAt + 1])
  const root = testScratch("mako-thread-move-ui-")
  const evidence = process.env.MAKO_TEST_EVIDENCE ? join(process.env.MAKO_TEST_EVIDENCE, "moves") : root
  await mkdir(evidence, { recursive: true })
  const server = await createServer({
    cacheDir: join(root, "cache"),
    define: { "import.meta.env.MAKO_MANUAL_RELOAD": "true" },
    plugins: [manualDevUpdates()],
    server: { host: "127.0.0.1", port, strictPort: port !== 0 },
  })
  await server.listen()
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "mako-thread-move-check", main: fileURLToPath(import.meta.url) }))
  const env = { ...process.env, MAKO_UI_TEST_ROOT: root, MAKO_UI_TEST_EVIDENCE: evidence, MAKO_UI_TEST_URL: server.resolvedUrls.local[0] }
  delete env.ELECTRON_RUN_AS_NODE
  try {
    const child = spawn(resolve("node_modules/.bin/electron"), [root], { stdio: "inherit", env })
    process.exitCode = await new Promise((resolveExit, reject) => {
      child.once("error", reject)
      child.once("exit", (code) => resolveExit(code ?? 1))
    })
  } finally {
    await server.close()
  }
}

/** The complete production move/store modules, with deferred bridge replies and observable location effects. */
async function checkMoveState() {
  const { readFile } = await import("node:fs/promises")
  const { createContext, runInContext } = await import("node:vm")
  const { webcrypto } = await import("node:crypto")
  const ts = await import("typescript")
  const code = await readFile(new URL("../src/state/cloud-moves.ts", import.meta.url), "utf8")
  const storeCode = await readFile(new URL("../src/state/store.ts", import.meta.url), "utf8")
  const world = (handler, conversations = {}, returnHandler = () => new Promise(() => {})) => {
    const calls = [], returns = [], effects = []
    const context = createContext({ crypto: webcrypto, console })
    const load = (source, dependencies) => {
      const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
      const exports = {}
      const module = runInContext(`(function(require,exports,module){${compiled}\n})`, context)
      module((id) => {
        assert.ok(id in dependencies, `unexpected dependency: ${id}`)
        return dependencies[id]
      }, exports, { exports })
      return exports
    }
    const store = load(storeCode, { react: {} })
    const bridge = {
      threadMove: async (...args) => { calls.push(args); return handler(...args) },
      threadReturn: async (...args) => { returns.push(args); return returnHandler(...args) },
    }
    const api = load(code, {
      sonner: { toast: { success: (...args) => effects.push(["success", args]), message: (...args) => effects.push(["message", args]), warning: (...args) => effects.push(["warning", args]) } },
      "@/state/providers": { providers: {} },
      "@/lib/bridge": { hasBridge: () => true, getMako: () => bridge },
      "@/state/acp-state": { acpStore: { get: () => ({ conversations }) }, updateAcpConversation: (id, apply) => {
        if (conversations[id]) conversations[id] = apply(conversations[id])
        effects.push(["location", id])
      } },
      "@/state/live-door": { receiveLive: (_id, _source, apply) => apply() },
      "@/state/live-recovery": { hydrateLive: async (id) => effects.push(["hydrate", id]) },
      "@/state/store": store,
    })
    return { api, calls, returns, effects, conversations, state: () => api.cloudMovesStore.get() }
  }
  const deferred = () => {
    let resolve, reject
    const promise = new Promise((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  const pending = () => new Promise(() => {})
  const results = []
  const check = async (name, run) => {
    let held
    try {
      await run((handler, conversations, returnHandler) => (held = world(handler, conversations, returnHandler)))
      results.push({ name, passed: true, calls: held.calls, returns: held.returns, effects: held.effects, conversations: held.conversations, state: held.state() })
    } catch (error) {
      results.push({ name, passed: false, error: String(error), calls: held?.calls, returns: held?.returns, effects: held?.effects, conversations: held?.conversations, state: held?.state() })
    }
  }
  await check("late A events cannot replace pending B or permit C", async (make) => {
    let count = 0
    const w = make(() => ++count === 1 ? { kind: "kept-here", reason: "A refused" } : pending())
    await w.api.moveToCloud("c", true)
    const A = w.calls[0][1]
    void w.api.retryFailedMove("c", A)
    const B = w.calls[1][1]
    assert.notEqual(A, B)
    const before = JSON.stringify(w.state())
    const effects = JSON.stringify(w.effects)
    for (const step of [{ kind: "kept-here", reason: "late A" }, { kind: "packing" }, { kind: "pausing" }, { kind: "handing-over" }, { kind: "resuming" }, { kind: "unsettled", reason: "late A" }, { kind: "own-branch", to: "other" }, { kind: "moved", conversations: ["c"] }]) {
      w.api.threadMoveStepped("c", A, step)
      assert.equal(JSON.stringify(w.state()), before, `${step.kind}: B owns the state`)
      assert.equal(JSON.stringify(w.effects), effects, `${step.kind}: no stale effects`)
    }
    await w.api.retryFailedMove("c", A)
    await w.api.moveToCloud("c")
    assert.equal(w.calls.length, 2, "no C while B is unresolved")
    w.api.threadMoveStepped("c", B, { kind: "kept-here", reason: "B refused" })
    void w.api.retryFailedMove("c", B)
    const C = w.calls[2][1]
    assert.notEqual(C, B)
    for (const old of [A, B, A]) w.api.threadMoveStepped("c", old, { kind: "kept-here", reason: "ABA replay" })
    assert.equal(w.state().moving.c.move, C)
    assert.equal(w.calls.length, 3)
  })
  await check("known-started status reply settles once without another event", async (make) => {
    let count = 0
    const w = make(() => ++count === 1 ? Promise.reject(new Error("lost reply")) : { kind: "moved", cloudThread: "fixture-cloud" })
    await w.api.moveToCloud("c")
    const move = w.calls[0][1]
    assert.equal(w.state().moving.c.step.kind, "unsettled")
    await w.api.checkMoveAgain("c")
    assert.equal(w.calls[1][1], move)
    assert.equal(w.state().moving.c, undefined)
    assert.deepEqual(w.effects.filter(([kind]) => kind === "location" || kind === "hydrate"), [["location", "c"], ["hydrate", "c"]])
    const effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", move, { kind: "moved", conversations: ["c"] })
    w.api.threadMoveStepped("c", move, { kind: "kept-here", reason: "late" })
    await w.api.checkMoveAgain("c")
    assert.equal(JSON.stringify(w.effects), effects)
    assert.equal(w.state().failedMoves.c, undefined)
    assert.equal(w.calls.length, 2)
  })
  await check("fork loss checks same source operation from the current tab", async (make) => {
    const first = deferred(), second = deferred()
    let count = 0
    const w = make(() => ++count === 1 ? first.promise : second.promise)
    const request = w.api.moveToCloud("source")
    const move = w.calls[0][1]
    w.api.threadMoveStepped("source", move, { kind: "own-branch", to: "fork" })
    first.reject(new Error("lost after fork"))
    await request
    assert.equal(w.state().moving.source, undefined)
    assert.equal(w.state().moving.fork.step.kind, "unsettled")
    await w.api.moveToCloud("source")
    await w.api.moveToCloud("fork")
    const checking = w.api.checkMoveAgain("fork")
    await w.api.checkMoveAgain("fork")
    await w.api.checkMoveAgain("source")
    assert.equal(w.calls.length, 2)
    assert.equal(w.calls[1][0], "source")
    assert.equal(w.calls[1][1], move)
    const before = JSON.stringify(w.state())
    for (const [id, step] of [["source", { kind: "kept-here", reason: "stale origin" }], ["source", { kind: "own-branch", to: "alien" }], ["other-thread", { kind: "packing" }]]) w.api.threadMoveStepped(id, move, step)
    assert.equal(JSON.stringify(w.state()), before, "only the current target may report steps")
    second.resolve({ kind: "moved", cloudThread: "fixture-cloud", conversation: "fork" })
    await checking
    assert.equal(w.state().moving.fork, undefined)
    assert.deepEqual(w.effects.filter(([kind]) => kind === "location" || kind === "hydrate"), [["location", "fork"], ["hydrate", "fork"]])
  })
  await check("fork returned refusal without event stays recoverable at fork", async (make) => {
    const first = deferred()
    const w = make(() => first.promise)
    const request = w.api.moveToCloud("source")
    const move = w.calls[0][1]
    w.api.threadMoveStepped("source", move, { kind: "own-branch", to: "fork" })
    first.resolve({ kind: "kept-here", reason: "fork has not started" })
    await request
    assert.equal(w.state().moving.fork, undefined)
    assert.equal(w.state().failedMoves.fork.move, move)
    assert.equal(w.state().failedMoves.source, undefined)
    w.api.dismissFailedMove("fork", move)
    const before = JSON.stringify(w.state())
    for (const id of ["source", "fork"]) for (const step of [{ kind: "packing" }, { kind: "kept-here", reason: "dismissed" }, { kind: "own-branch", to: "source" }]) w.api.threadMoveStepped(id, move, step)
    assert.equal(JSON.stringify(w.state()), before, "dismissed terminal identity cannot return")
  })
  await check("late RPC refusal or loss cannot replace newer attempt", async (make) => {
    const first = deferred(), second = deferred()
    let count = 0
    const w = make(() => ++count === 1 ? first.promise : second.promise)
    const request = w.api.moveToCloud("c")
    const A = w.calls[0][1]
    w.api.threadMoveStepped("c", A, { kind: "kept-here", reason: "A refused" })
    const retry = w.api.retryFailedMove("c", A)
    const B = w.calls[1][1]
    first.resolve({ kind: "kept-here", reason: "late A RPC" })
    await request
    assert.equal(w.state().moving.c.move, B)
    second.reject(new Error("lost B"))
    await retry
    assert.equal(w.state().moving.c.step.kind, "unsettled")
    assert.equal(w.state().moving.c.move, B)
  })
  for (const kind of ["moved", "unsettled", "lost"]) await check(`late A RPC ${kind} cannot settle pending B`, async (make) => {
    const first = deferred()
    let count = 0
    const w = make(() => ++count === 1 ? first.promise : pending())
    const request = w.api.moveToCloud("c")
    const A = w.calls[0][1]
    w.api.threadMoveStepped("c", A, { kind: "kept-here", reason: "A refused" })
    void w.api.retryFailedMove("c", A)
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    if (kind === "lost") first.reject(new Error("late A transport loss"))
    else first.resolve(kind === "moved" ? { kind, cloudThread: "fixture-cloud" } : { kind, reason: "late A" })
    await request
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects)
    assert.equal(w.calls.length, 2)
  })
  await check("retarget during a status check retains the check lock and origin", async (make) => {
    const second = deferred()
    let count = 0
    const w = make(() => ++count === 1 ? Promise.reject(new Error("lost first reply")) : second.promise)
    await w.api.moveToCloud("source", true)
    const move = w.calls[0][1]
    const checking = w.api.checkMoveAgain("source")
    w.api.threadMoveStepped("source", move, { kind: "own-branch", to: "fork" })
    w.api.threadMoveStepped("fork", move, { kind: "unsettled", reason: "still checking" })
    assert.equal(w.state().moving.fork.checking, true)
    await w.api.checkMoveAgain("fork")
    assert.equal(w.calls.length, 2)
    assert.equal(w.calls[1][0], "source")
    assert.equal(w.calls[1][1], move)
    assert.equal(w.calls[1][2].why, "asked")
    second.reject(new Error("lost check reply"))
    await checking
    assert.equal(w.state().moving.fork.step.kind, "unsettled")
    assert.equal(w.state().moving.fork.checking, false)
    assert.equal(w.state().moving.fork.handOff, true)
  })
  await check("first host move adoption, target collision and disposed reply", async (make) => {
    const reply = deferred()
    const w = make(() => reply.promise)
    w.api.threadMoveStepped("other", "external", { kind: "pausing" })
    assert.equal(w.state().moving.other.handOff, true, "another window's first event is adopted")
    const request = w.api.moveToCloud("source")
    const move = w.calls[0][1]
    w.api.threadMoveStepped("source", move, { kind: "own-branch", to: "other" })
    assert.equal(w.state().moving.other.move, "external", "retarget cannot seize another operation")
    assert.equal(w.state().moving.source.move, move)
    w.api.threadMoveStepped("other", "external", { kind: "moved", conversations: ["other"] })
    assert.equal(w.effects.filter(([kind]) => kind === "location").length, 1)
    w.api.cloudMovesStore.set({ moving: {}, failedMoves: {} })
    reply.resolve({ kind: "kept-here", reason: "disposed" })
    await request
    const before = JSON.stringify(w.state())
    w.api.threadMoveStepped("source", move, { kind: "packing" })
    assert.equal(JSON.stringify(w.state()), before, "disposed state cannot be resurrected by an old event")
    w.api.threadMoveStepped("fresh", "new-host-move", { kind: "packing" })
    assert.equal(w.state().moving.fresh.move, "new-host-move")
  })
  await check("released is not ready; missed fork event uses authoritative conversation", async (make) => {
    let count = 0
    const w = make(() => ++count === 1 ? Promise.reject(new Error("lost")) : count === 2 ? { kind: "released", cloudThread: "fixture-cloud" } : { kind: "moved", cloudThread: "fixture-cloud", conversation: "fork" })
    await w.api.moveToCloud("source")
    await w.api.checkMoveAgain("source")
    assert.equal(w.state().moving.source.step.kind, "unsettled")
    assert.equal(w.effects.length, 0)
    await w.api.checkMoveAgain("source")
    assert.equal(new Set(w.calls.map((call) => call[1])).size, 1)
    assert.equal(w.state().moving.source, undefined)
    assert.equal(w.state().moving.fork, undefined)
    assert.deepEqual(w.effects.filter(([kind]) => kind === "location" || kind === "hydrate"), [["location", "fork"], ["hydrate", "fork"]])
  })
  const locations = (w) => w.effects.filter(([kind]) => kind === "location" || kind === "hydrate")
  // The real moved event names every plan.sessions conversation; the RPC contract has no membership list.
  for (const order of ["rpc-first", "event-first"]) await check(`${order} full membership converges without repeating effects`, async (make) => {
    const reply = deferred()
    const w = make(() => reply.promise)
    const request = w.api.moveToCloud("c", true)
    const move = w.calls[0][1]
    const full = { kind: "moved", conversations: ["c", "sibling"], continued: true }
    if (order === "event-first") w.api.threadMoveStepped("c", move, full)
    reply.resolve({ kind: "moved", cloudThread: "fixture-cloud" })
    await request
    if (order === "rpc-first") w.api.threadMoveStepped("c", move, full)
    assert.deepEqual(locations(w), [["location", "c"], ["hydrate", "c"], ["location", "sibling"], ["hydrate", "sibling"]])
    assert.equal(new Set(w.effects.filter(([kind]) => kind === "success").map(([, args]) => args[1].id)).size, 1, "richer metadata updates the existing toast ID")
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", move, structuredClone(full))
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects, "identical completion has no repeated effects")
    assert.equal(w.calls.length, 1)
  })
  await check("partial then full completion enriches only its own target and ID", async (make) => {
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }))
    await w.api.moveToCloud("c")
    const move = w.calls[0][1]
    w.api.threadMoveStepped("foreign", "refused-foreign", { kind: "kept-here", reason: "not moving" })
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", "refused-foreign", { kind: "moved", conversations: ["c", "wrong-id-member"] })
    w.api.threadMoveStepped("wrong-target", move, { kind: "moved", conversations: ["wrong-target", "wrong-target-member"] })
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects)
    w.api.threadMoveStepped("c", move, { kind: "moved", conversations: ["c"] })
    const carried = { repositories: 2, outside: 0, left: [] }
    const full = { kind: "moved", conversations: ["c", "sibling", "sibling"], continued: true, carried, whileAway: { behind: true } }
    w.api.threadMoveStepped("c", move, full)
    assert.deepEqual(locations(w), [["location", "c"], ["hydrate", "c"], ["location", "sibling"], ["hydrate", "sibling"]])
    assert.equal(w.state().moves[move].completed.continued, true)
    assert.equal(w.state().moves[move].completed.carried.repositories, 2)
    assert.equal(w.state().moves[move].completed.whileAway.behind, true)
    const enriched = JSON.stringify(w.state()), enrichedEffects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", move, structuredClone(full))
    w.api.threadMoveStepped("c", move, { kind: "moved", conversations: ["c"] })
    assert.equal(JSON.stringify(w.state()), enriched)
    assert.equal(JSON.stringify(w.effects), enrichedEffects)
    assert.equal(w.calls.length, 1)
  })
  await check("A membership cannot reclaim its target after new B or B dismissal", async (make) => {
    let count = 0
    const w = make(() => ++count === 1 ? { kind: "moved", cloudThread: "fixture-cloud" } : pending())
    await w.api.moveToCloud("c")
    const A = w.calls[0][1]
    void w.api.moveToCloud("c")
    const B = w.calls[1][1]
    const full = { kind: "moved", conversations: ["c", "sibling"] }
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", A, full)
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects)
    assert.equal(w.state().moving.c.move, B)
    w.api.threadMoveStepped("c", B, { kind: "kept-here", reason: "B refused" })
    w.api.dismissFailedMove("c", B)
    const dismissed = JSON.stringify(w.state()), dismissedEffects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", A, full)
    assert.equal(JSON.stringify(w.state()), dismissed)
    assert.equal(JSON.stringify(w.effects), dismissedEffects)
    assert.equal(w.calls.length, 2)
  })
  await check("late A membership cannot refresh a sibling owned by newer B", async (make) => {
    let count = 0
    const w = make(() => ++count === 1 ? { kind: "moved", cloudThread: "fixture-cloud" } : pending())
    await w.api.moveToCloud("c")
    const A = w.calls[0][1]
    void w.api.moveToCloud("sibling")
    const B = w.calls[1][1]
    w.api.threadMoveStepped("c", A, { kind: "moved", conversations: ["c", "sibling"] })
    assert.equal(w.state().moving.sibling.move, B)
    assert.deepEqual(locations(w), [["location", "c"], ["hydrate", "c"]])
    w.api.threadMoveStepped("sibling", B, { kind: "kept-here", reason: "B refused" })
    w.api.threadMoveStepped("c", A, { kind: "moved", conversations: ["c", "sibling"] })
    assert.deepEqual(locations(w), [["location", "c"], ["hydrate", "c"]])
  })
  await check("RPC-only completion refreshes all host-derived known Thread members", async (make) => {
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), {
      c: { key: "c", kind: "live", threadId: "thread", sessionId: "main" },
      sibling: { key: "sibling", kind: "live", threadId: "thread", sessionId: "side" },
      unrelated: { key: "unrelated", kind: "live", threadId: "other-thread", sessionId: "other" },
    })
    await w.api.moveToCloud("c")
    assert.deepEqual(locations(w), [["location", "c"], ["hydrate", "c"], ["hydrate", "sibling"]], "known Thread membership selects an authoritative readback, not a synthetic location")
    w.api.threadMoveStepped("c", w.calls[0][1], { kind: "moved", conversations: ["c", "sibling"] })
    assert.deepEqual(locations(w), [["location", "c"], ["hydrate", "c"], ["hydrate", "sibling"], ["location", "sibling"]], "full host membership sets location without hydrating twice")
    assert.equal(w.calls.length, 1)
  })
  await check("RPC fork membership uses the current Thread rather than its old source", async (make) => {
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud", conversation: "fork" }), {
      source: { key: "source", kind: "live", threadId: "old-thread" },
      oldSibling: { key: "oldSibling", kind: "live", threadId: "old-thread" },
      fork: { key: "fork", kind: "live", threadId: "fork-thread" },
      forkSibling: { key: "forkSibling", kind: "live", threadId: "fork-thread" },
    })
    await w.api.moveToCloud("source")
    assert.deepEqual(locations(w), [["location", "fork"], ["hydrate", "fork"], ["hydrate", "forkSibling"]])
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("source", w.calls[0][1], { kind: "moved", conversations: ["source", "oldSibling"] })
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects)
  })
  const members = () => ({
    c: { key: "c", kind: "live", threadId: "thread" },
    sibling: { key: "sibling", kind: "live", threadId: "thread", elsewhere: "a cloud machine" },
  })
  await check("confirmed return fences the earlier RPC-first full outbound event", async (make) => {
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members())
    await w.api.moveToCloud("c")
    const A = w.calls[0][1]
    w.api.threadReturnStepped("c", "return-B", { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(w.conversations.c.elsewhere, undefined)
    assert.equal(w.conversations.sibling.elsewhere, undefined)
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", A, { kind: "moved", conversations: ["c", "sibling"], continued: true })
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects, "no cloud toast, location or readback after confirmed return")
    assert.equal(w.conversations.sibling.elsewhere, undefined)
    w.api.threadReturnStepped("c", "return-B", { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(JSON.stringify(w.effects), effects, "duplicate return has no effects")
  })
  await check("new outbound after return supersedes that return's late completion", async (make) => {
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members())
    await w.api.moveToCloud("c")
    w.api.threadReturnStepped("c", "return-B", { kind: "back", conversations: ["c", "sibling"] })
    await w.api.moveToCloud("c")
    const C = w.calls[1][1]
    assert.notEqual(C, w.calls[0][1])
    w.api.threadMoveStepped("c", C, { kind: "moved", conversations: ["c", "sibling"] })
    assert.equal(w.conversations.c.elsewhere, "a cloud machine")
    assert.equal(w.conversations.sibling.elsewhere, "a cloud machine")
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    w.api.threadReturnStepped("c", "return-B", { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects)
  })
  await check("partial confirmed return accepts full participants once without old outbound enrichment", async (make) => {
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members())
    await w.api.moveToCloud("c")
    const A = w.calls[0][1]
    w.api.threadReturnStepped("c", "return-B", { kind: "back", conversations: ["c"] })
    assert.equal(w.conversations.c.elsewhere, undefined)
    assert.equal(w.conversations.sibling.elsewhere, "a cloud machine", "partial membership does not declare other sessions local")
    const effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", A, { kind: "moved", conversations: ["c", "sibling"], continued: true })
    assert.equal(JSON.stringify(w.effects), effects)
    w.api.threadReturnStepped("c", "return-B", { kind: "back", conversations: ["c", "sibling", "sibling"] })
    assert.equal(w.conversations.sibling.elsewhere, undefined)
    const full = JSON.stringify(w.effects)
    w.api.threadReturnStepped("c", "return-B", { kind: "back", conversations: ["c"] })
    assert.equal(JSON.stringify(w.effects), full)
    assert.equal(w.effects.filter(([kind, id]) => kind === "location" && id === "c").length, 2, "one outbound and one return location")
  })
  await check("confirmed sibling return fences a fork's origin and unresolved RPC", async (make) => {
    const reply = deferred()
    let count = 0
    const w = make(() => ++count === 1 ? reply.promise : { kind: "moved", cloudThread: "fixture-cloud" }, {
      source: { key: "source", kind: "live", threadId: "old-thread" },
      fork: { key: "fork", kind: "live", threadId: "thread", elsewhere: "a cloud machine" },
      sibling: { key: "sibling", kind: "live", threadId: "thread", elsewhere: "a cloud machine" },
    })
    const request = w.api.moveToCloud("source")
    const A = w.calls[0][1]
    w.api.threadMoveStepped("source", A, { kind: "own-branch", to: "fork" })
    w.api.threadReturnStepped("sibling", "return-B", { kind: "back", conversations: ["fork", "sibling"] })
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    reply.resolve({ kind: "moved", cloudThread: "fixture-cloud", conversation: "fork" })
    await request
    w.api.threadMoveStepped("fork", A, { kind: "moved", conversations: ["fork", "sibling"] })
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects)
    assert.equal(w.state().moving.fork, undefined)
    await w.api.moveToCloud("fork")
    assert.equal(w.calls.length, 2, "a confirmed return does not leave an obsolete outbound lock")
  })
  await check("mismatched return ID or address cannot acquire local ownership", async (make) => {
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members())
    await w.api.moveToCloud("c")
    const A = w.calls[0][1]
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    w.api.threadReturnStepped("c", A, { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(JSON.stringify(w.state()), before, "an outbound ID cannot become a return")
    assert.equal(JSON.stringify(w.effects), effects)
    w.api.threadReturnStepped("c", "return-B", { kind: "packing" })
    const pendingState = JSON.stringify(w.state().returning), pendingEffects = JSON.stringify(w.effects)
    w.api.threadReturnStepped("wrong-target", "return-B", { kind: "back", conversations: ["c", "sibling"] })
    w.api.threadReturnStepped("c", "wrong-ID", { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(JSON.stringify(w.state().returning), pendingState)
    assert.equal(w.state().moves["wrong-ID"]?.ignored, true, "an incompatible ID is remembered without granting it authority")
    assert.equal(JSON.stringify(w.effects), pendingEffects)
    w.api.threadReturnStepped("c", "return-B", { kind: "stayed", reason: "refused" })
    const stayed = JSON.stringify(w.effects)
    w.api.threadReturnStepped("c", "return-B", { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(JSON.stringify(w.effects), stayed, "a refused return cannot later acquire authority")
    w.api.threadMoveStepped("c", A, { kind: "moved", conversations: ["c", "sibling"] })
    assert.equal(w.conversations.sibling.elsewhere, "a cloud machine")
    const final = JSON.stringify(w.state()), finalEffects = JSON.stringify(w.effects)
    w.api.threadReturnStepped("c", "wrong-ID", { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(JSON.stringify(w.state()), final)
    assert.equal(JSON.stringify(w.effects), finalEffects, "a rejected ID cannot gain authority after the current operation ends")
  })
  await check("unsettled return has no local authority; confirmed back then fences outbound", async (make) => {
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members())
    await w.api.moveToCloud("c")
    const A = w.calls[0][1]
    w.api.threadReturnStepped("c", "return-B", { kind: "packing" })
    w.api.threadReturnStepped("c", "return-B", { kind: "unsettled", reason: "unknown", waitsOn: "cloud" })
    w.api.threadMoveStepped("c", A, { kind: "moved", conversations: ["c", "sibling"] })
    assert.equal(w.conversations.c.elsewhere, "a cloud machine")
    assert.equal(w.conversations.sibling.elsewhere, "a cloud machine")
    w.api.threadReturnStepped("c", "return-B", { kind: "back", conversations: ["c", "sibling"] })
    const effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", A, { kind: "moved", conversations: ["c", "sibling"], continued: true })
    assert.equal(JSON.stringify(w.effects), effects)
    assert.equal(w.calls.length, 1)
  })
  await check("same-ID return status back uses readbacks then full host membership", async (make) => {
    let count = 0
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members(), () => ++count === 1 ? { kind: "unsettled", reason: "unknown", waitsOn: "cloud" } : { kind: "back" })
    await w.api.moveToCloud("c")
    await w.api.bringBack("c")
    assert.equal(w.state().returning.c.step.kind, "unsettled")
    await w.api.askReturnAgain("c")
    const B = w.returns[0][1]
    assert.equal(w.returns.length, 2)
    assert.equal(w.returns[1][1], B)
    assert.equal(w.conversations.c.elsewhere, undefined)
    assert.equal(w.conversations.sibling.elsewhere, "a cloud machine", "RPC readback is not synthetic local membership")
    const effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("c", w.calls[0][1], { kind: "moved", conversations: ["c", "sibling"], continued: true })
    assert.equal(JSON.stringify(w.effects), effects)
    const reads = w.effects.filter(([kind, id]) => kind === "hydrate" && id === "sibling").length
    w.api.threadReturnStepped("c", B, { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(w.conversations.sibling.elsewhere, undefined)
    assert.equal(w.effects.filter(([kind, id]) => kind === "hydrate" && id === "sibling").length, reads)
    assert.equal(w.calls.length, 1)
  })
  for (const outcome of ["back", "lost"]) await check(`late return RPC ${outcome} cannot replace newer outbound`, async (make) => {
    const reply = deferred()
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members(), () => reply.promise)
    await w.api.moveToCloud("c")
    const returning = w.api.bringBack("c")
    const B = w.returns[0][1]
    w.api.threadReturnStepped("c", B, { kind: "back", conversations: ["c", "sibling"] })
    await w.api.moveToCloud("c")
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    if (outcome === "back") reply.resolve({ kind: "back" })
    else reply.reject(new Error("late return transport loss"))
    await returning
    w.api.threadReturnStepped("c", B, { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects)
  })
  await check("return transport loss stays uncertain and checks the same operation", async (make) => {
    let count = 0
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members(), () => ++count === 1 ? Promise.reject(new Error("lost return reply")) : { kind: "back" })
    await w.api.moveToCloud("c")
    await w.api.bringBack("c")
    assert.equal(w.state().returning.c.step.kind, "unsettled")
    assert.equal(w.conversations.c.elsewhere, "a cloud machine")
    await w.api.moveToCloud("c")
    assert.equal(w.calls.length, 1, "an unresolved return cannot start another outbound")
    await w.api.askReturnAgain("c")
    assert.equal(w.returns.length, 2)
    assert.equal(w.returns[0][1], w.returns[1][1])
    assert.equal(w.conversations.c.elsewhere, undefined)
  })
  await check("an existing host return ID does not replace the pending request without its reply", async (make) => {
    const reply = deferred()
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members(), () => reply.promise)
    await w.api.moveToCloud("c")
    const returning = w.api.bringBack("c")
    const requested = w.returns[0][1]
    w.api.threadReturnStepped("c", "host-open-plan", { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(w.state().returning.c.move, requested)
    assert.equal(w.conversations.c.elsewhere, "a cloud machine", "a mismatched ID cannot settle this request")
    reply.resolve({ kind: "back" })
    await returning
    assert.equal(w.conversations.c.elsewhere, undefined, "the actual host RPC back outcome establishes return authority")
    assert.equal(w.state().returning.c, undefined)
    await w.api.moveToCloud("c")
    const effects = JSON.stringify(w.effects)
    w.api.threadReturnStepped("c", "host-open-plan", { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(JSON.stringify(w.effects), effects)
  })
  for (const outcome of ["back", "lost"]) await check(`new member completion retires pending return before its late ${outcome} reply`, async (make) => {
    const reply = deferred()
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members(), () => reply.promise)
    await w.api.moveToCloud("c")
    const returning = w.api.bringBack("c")
    const B = w.returns[0][1]
    await w.api.moveToCloud("sibling")
    const C = w.calls[1][1]
    w.api.threadMoveStepped("sibling", C, { kind: "moved", conversations: ["c", "sibling"] })
    assert.equal(w.state().returning.c, undefined, "confirmed newer ownership releases the obsolete spinner immediately")
    assert.equal(w.state().moves[B].superseded, true)
    assert.equal(w.state().moves[B].settled, undefined, "retirement does not invent a local return")
    assert.equal(w.conversations.c.elsewhere, "a cloud machine")
    assert.equal(w.conversations.sibling.elsewhere, "a cloud machine")
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    if (outcome === "back") reply.resolve({ kind: "back" })
    else reply.reject(new Error("obsolete return reply lost"))
    await returning
    for (const step of [{ kind: "packing" }, { kind: "unsettled", reason: "late", waitsOn: "cloud" }, { kind: "stayed", reason: "late" }, { kind: "back", conversations: ["c", "sibling"] }]) w.api.threadReturnStepped("c", B, step)
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects, "retired replies/events have no location, readback or toast effects")
    assert.equal(w.calls.length, 2, "cleanup starts no move")
    await w.api.moveToCloud("c")
    assert.equal(w.calls.length, 3, "an explicit new move is no longer blocked by B")
  })
  await check("obsolete return cleanup cannot remove a newer return at the same address", async (make) => {
    const first = deferred(), newer = deferred()
    let count = 0
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), members(), () => ++count === 1 ? first.promise : newer.promise)
    await w.api.moveToCloud("c")
    const oldReturn = w.api.bringBack("c")
    const B = w.returns[0][1]
    await w.api.moveToCloud("sibling")
    w.api.threadMoveStepped("sibling", w.calls[1][1], { kind: "moved", conversations: ["c", "sibling"] })
    assert.equal(w.state().returning.c, undefined)
    const pending = w.api.bringBack("c")
    const D = w.returns[1][1]
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    first.resolve({ kind: "back" })
    await oldReturn
    w.api.threadReturnStepped("c", B, { kind: "back", conversations: ["c", "sibling"] })
    assert.equal(w.state().returning.c.move, D)
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects)
    newer.resolve({ kind: "back" })
    await pending
    assert.equal(w.conversations.c.elsewhere, undefined, "the current return still settles normally")
  })
  await check("supersession preserves an unrelated older pending return", async (make) => {
    const old = deferred(), neighbor = deferred()
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), { ...members(), other: { key: "other", kind: "live", threadId: "other-thread", elsewhere: "a cloud machine" } }, (id) => id === "other" ? neighbor.promise : old.promise)
    await w.api.moveToCloud("c")
    const pending = w.api.bringBack("c")
    const unaffected = w.api.bringBack("other")
    const U = w.returns[1][1]
    await w.api.moveToCloud("sibling")
    w.api.threadMoveStepped("sibling", w.calls[1][1], { kind: "moved", conversations: ["c", "sibling"] })
    assert.equal(w.state().returning.c, undefined)
    assert.equal(w.state().returning.other.move, U)
    assert.equal(w.state().moves[U].superseded, undefined)
    old.resolve({ kind: "back" })
    await pending
    assert.equal(w.state().returning.other.move, U)
    neighbor.resolve({ kind: "back" })
    await unaffected
    assert.equal(w.conversations.other.elsewhere, undefined)
  })
  await check("late full membership retires an older return only once its address is confirmed", async (make) => {
    const reply = deferred()
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), { c: { key: "c", kind: "live" }, sibling: { key: "sibling", kind: "live" } }, () => reply.promise)
    await w.api.moveToCloud("c")
    const pending = w.api.bringBack("c")
    const B = w.returns[0][1]
    await w.api.moveToCloud("sibling")
    const C = w.calls[1][1]
    assert.equal(w.state().returning.c.move, B, "singleton completion cannot claim another unknown member")
    w.api.threadMoveStepped("sibling", C, { kind: "moved", conversations: ["sibling", "c"] })
    assert.equal(w.state().returning.c, undefined)
    const before = JSON.stringify(w.state()), effects = JSON.stringify(w.effects)
    w.api.threadMoveStepped("sibling", C, { kind: "moved", conversations: ["sibling", "c"] })
    reply.resolve({ kind: "back" })
    await pending
    assert.equal(JSON.stringify(w.state()), before)
    assert.equal(JSON.stringify(w.effects), effects)
  })
  await check("late full completion cannot retire a return registered after that outbound operation", async (make) => {
    const old = deferred(), newer = deferred()
    const w = make(() => ({ kind: "moved", cloudThread: "fixture-cloud" }), { c: { key: "c", kind: "live" }, sibling: { key: "sibling", kind: "live" }, alias: { key: "alias", kind: "live" } }, (id) => id === "alias" ? newer.promise : old.promise)
    await w.api.moveToCloud("c")
    const pending = w.api.bringBack("c")
    await w.api.moveToCloud("sibling")
    const C = w.calls[1][1]
    const current = w.api.bringBack("alias")
    const D = w.returns[1][1]
    w.api.threadMoveStepped("sibling", C, { kind: "moved", conversations: ["sibling", "c", "alias"] })
    assert.equal(w.state().returning.c, undefined)
    assert.equal(w.state().returning.alias.move, D)
    assert.equal(w.state().moves[D].superseded, undefined)
    old.resolve({ kind: "back" })
    await pending
    assert.equal(w.state().returning.alias.move, D)
    newer.resolve({ kind: "back" })
    await current
    assert.equal(w.conversations.alias.elsewhere, undefined)
  })
  if (process.env.MAKO_TEST_EVIDENCE) {
    await mkdir(process.env.MAKO_TEST_EVIDENCE, { recursive: true })
    await writeFile(join(process.env.MAKO_TEST_EVIDENCE, "move-state-controls.json"), JSON.stringify(results, null, 2))
  }
  for (const result of results) console.log(`Move state: ${result.passed ? "PASS" : "FAIL"} ${result.name}${result.error ? `: ${result.error}` : ""}`)
  assert.ok(results.every((result) => result.passed), "production move state controls must all pass")
}

async function checkWindow() {
  const { app, BrowserWindow } = await import("electron")
  const root = process.env.MAKO_UI_TEST_ROOT
  const evidence = process.env.MAKO_UI_TEST_EVIDENCE
  const base = process.env.MAKO_UI_TEST_URL
  app.setPath("userData", join(root, "profile"))
  withMotion(app)
  await app.whenReady()
  const window = new BrowserWindow({ width: 1280, height: 1240, show: false, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
  atSize(window, 1280, 1240)
  const page = window.webContents
  page.debugger.attach("1.3")
  const watchdog = setTimeout(() => {
    console.error("Thread move UI verification exceeded its 240-second limit")
    app.exit(1)
  }, 240_000)
  page.on("console-message", (details) => {
    if (details.level === "error") console.error(`[ui] ${details.message}`)
  })
  const evaluate = (code) => page.executeJavaScript(code)
  const frames = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))")
  /** `toast`: the one toast shown, the one holding that text; otherwise none, the fixture desk's own included. */
  let shownToast
  const settle = async () => {
    // The fixture desk's own toasts, such as its deliberately broken plugin, aren't what's shown here.
    if (shownToast) await evaluate(`(() => { document.getElementById('hide-toasts')?.remove(); for (const node of document.querySelectorAll('[data-sonner-toast]')) node.style.display = node.innerText.includes(${JSON.stringify(shownToast)}) ? '' : 'none'; return true })()`)
    else await evaluate(`(() => { if (!document.getElementById('hide-toasts')) document.head.insertAdjacentHTML('beforeend', '<style id="hide-toasts">[data-sonner-toaster]{display:none!important}</style>'); return true })()`)
    await evaluate("document.fonts.ready.then(() => true)")
    await evaluate(`Promise.all(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {}))).then(() => true)`)
    await frames()
  }
  /** The whole window, and a crop around `around` when given. */
  const capture = async (name, around) => {
    await settle()
    await writeFile(join(evidence, `${name}.png`), (await page.capturePage()).toPNG())
    await writeFile(join(evidence, `${name}.json`), JSON.stringify(await evaluate(`({
      trace: window.moveTrace,
      calls: window.moveCalls,
      move: document.querySelector('[data-thread-move]')?.dataset.threadMove,
      returning: document.querySelector('[data-thread-return]')?.dataset.threadReturn,
      place: document.querySelector('[data-run-place]')?.dataset.runPlace
    })`), null, 2))
    if (!around) return
    const rect = await evaluate(`(() => {
      const nodes = ${JSON.stringify(around)}.flatMap(selector => [...document.querySelectorAll(selector)])
      if (!nodes.length) return null
      const rects = nodes.map(node => node.getBoundingClientRect())
      const pad = 24
      const x = Math.max(0, Math.floor(Math.min(...rects.map(r => r.left)) - pad))
      const y = Math.max(0, Math.floor(Math.min(...rects.map(r => r.top)) - pad))
      return { x, y, width: Math.min(innerWidth - x, Math.ceil(Math.max(...rects.map(r => r.right)) + pad - x)), height: Math.min(innerHeight - y, Math.ceil(Math.max(...rects.map(r => r.bottom)) + pad - y)) }
    })()`)
    if (rect) await writeFile(join(evidence, `${name}-crop.png`), (await page.capturePage(rect)).toPNG())
  }
  /**
   * The other theme, at once. Its colours would otherwise ease over a transition on every element, and each capture
   * waits for every animation to end (`settle`): 45 pairs of captures spent most of a run on those. Transitions are off
   * only while the class changes, so the captures are of the same settled colours, and the app's own animations,
   * which `settle` is there for, run as they do.
   */
  const theme = async (next) => {
    await evaluate(`(() => { if (!document.getElementById('theme-at-once')) document.head.insertAdjacentHTML('beforeend', '<style id="theme-at-once">*,*::before,*::after{transition:none!important}</style>'); return true })()`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({theme: ${JSON.stringify(next)}}))`)
    await evaluate(`new Promise(resolve => { const check = () => document.documentElement.classList.contains('light') === ${next === "light"} ? resolve(true) : requestAnimationFrame(check); check() })`)
    await frames()
    await evaluate(`(() => { document.getElementById('theme-at-once')?.remove(); return true })()`)
  }
  const both = async (name, around) => {
    const phase = await evaluate(`JSON.stringify([document.querySelector('[data-thread-move]')?.dataset.threadMove, document.querySelector('[data-thread-return]')?.dataset.threadReturn])`)
    await capture(name, around)
    await theme("light")
    await capture(`${name}-light`, around)
    await theme("dark")
    if (around?.includes('[data-thread-move]') || around?.includes('[data-thread-return]'))
      assert.equal(await evaluate(`JSON.stringify([document.querySelector('[data-thread-move]')?.dataset.threadMove, document.querySelector('[data-thread-return]')?.dataset.threadReturn])`), phase, `${name}: the captured phase stays until the check advances it`)
  }
  /** The toast holding `title`, alone, in both themes. */
  const toastShot = async (name, title) => {
    await until(`[...document.querySelectorAll('[data-sonner-toast]')].some((node) => node.innerText.includes(${JSON.stringify(title)}))`, title)
    shownToast = title
    await both(name, ['[data-sonner-toast]:not([style*="display: none"])'])
    shownToast = undefined
  }
  const until = async (code, label = code) => {
    const deadline = Date.now() + 30_000
    while (!(await evaluate(code))) {
      if (Date.now() > deadline) {
        await capture("failure")
        throw new Error(`UI condition timed out: ${label}`)
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 30))
    }
  }
  const point = (selector) =>
    evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) throw new Error('Missing target ' + ${JSON.stringify(selector)}); const r = node.getBoundingClientRect(); return {x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2)} })()`)
  const press = async (selector, button) => {
    const at = await point(selector)
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", button, clickCount: 1, ...at })
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", button, clickCount: 1, ...at })
  }
  const click = (selector) => press(selector, "left")
  /** The button inside `within` whose text includes `text`, clicked with trusted input. */
  const clickText = async (within, text) => {
    await evaluate(`(() => { document.querySelectorAll('[data-test-target]').forEach(node => node.removeAttribute('data-test-target')); const node = [...document.querySelectorAll(${JSON.stringify(`${within} button`)})].find(each => each.innerText.includes(${JSON.stringify(text)})); if (!node) throw new Error('Missing button ' + ${JSON.stringify(text)}); node.setAttribute('data-test-target', ''); return true })()`)
    await click("[data-test-target]")
  }
  const type = (text) => page.debugger.sendCommand("Input.insertText", { text })
  const enter = async () => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 })
  }
  const phases = (action) => evaluate(`window.mockMovePhases.${action}(), true`)
  /** A new Thread on its own branch, signed in with the cloud: its first message makes its worktree and starts it there. */
  const startThread = async (query, inWorktree = true) => {
    await window.loadURL(`${base}?mock&cloud=signed-in&invited&making=fast&move-steps${query}`)
    await evaluate(`import('/src/state/prefs.ts').then(({prefsStore}) => prefsStore.set({railGrouping: 'project', railWidth: 264, theme: 'dark', newThreadsInWorktree: ${inWorktree}}))`)
    await until(`Boolean(document.querySelector('.composer-input')) && !document.querySelector('.composer-input').readOnly`, "the composer")
    await evaluate(`(() => {
      window.moveTrace = []
      window.mako.onEvent(event => {
        if (event.type === 'thread-move-step' || event.type === 'thread-return-step') window.moveTrace.push({ at: performance.now(), type: event.type, kind: event.step.kind })
      })
      return true
    })()`)
    await click(".composer-input")
    await type("Retry the billing webhooks with backoff")
    await enter()
    await until(`document.querySelector('[data-run-place="local"]') !== null`, "the open Thread's Local chip")
    await page.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: 900, y: 300 })
  }

  /** Record fixture calls, optionally refusing or losing the first reply without emitting an outcome event. */
  const recordMoves = async (first = "events") => evaluate(`(() => {
    const original = window.mako.threadMove
    window.moveCalls = []
    window.mako.threadMove = async (conversationId, move, options) => {
      window.moveCalls.push({ conversationId, move, options })
      if (window.moveCalls.length === 1 && ${JSON.stringify(first)} === 'refusal')
        return { kind: 'kept-here', reason: "The cloud couldn't clone example/private-service: GitHub access is missing for this repository." }
      if (window.moveCalls.length === 1 && ${JSON.stringify(first)} === 'lost')
        throw new Error('Fixture connection lost before the move reply arrived.')
      return original(conversationId, move, options)
    }
    return true
  })()`)
  const pressMove = async () => {
    await click('[data-run-place="local"]')
    await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
    await click('[data-thread-move-offer]')
  }

  // 1. A Thread on this Mac in its own worktree: its Local chip offers the move.
  await startThread("")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await both("local-chip", ['[data-run-place]', '[data-composer]'])
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  assert.equal(await evaluate(`document.querySelector('[data-thread-move-offer]').disabled`), false, "a quiet Thread in its own worktree can move")
  assert.match(await evaluate(`document.querySelector('[data-thread-move-offer]').innerText`), /Move to the cloud[\s\S]*same folder/)
  await both("move-offer", ['[data-thread-move-offer]', '[data-run-place]'])

  // 2. Moving: the strip above the composer says each step, and the chip says Moving.
  await phases("hold")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-thread-move="packing"]') !== null`, "sending ahead")
  assert.match(await evaluate(`document.querySelector('[data-run-place]').getAttribute('aria-label')`), /Moving/)
  await both("move-packing", ['[data-thread-move]', '[data-run-place]'])
  await phases("next")
  await until(`document.querySelector('[data-thread-move="handing-over"]') !== null`, "handing over")
  await both("move-handing-over", ['[data-thread-move]'])
  await phases("next")
  await until(`document.querySelector('[data-thread-move="resuming"]') !== null`, "resuming")
  await both("move-resuming", ['[data-thread-move]'])
  await phases("run")

  // 3. Moved: the strip goes, the chip says Cloud.
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved")
  await both("moved", ['[data-run-place]', '[data-composer]'])

  // 3b. The way back: the Cloud chip offers it, two steps above the composer, and Local once it's here.
  await click('[data-run-place="cloud"]')
  await until(`document.querySelector('[data-thread-return-offer]') !== null`, "the return offer")
  assert.equal(await evaluate(`document.querySelector('[data-thread-return-offer]').disabled`), false, "a quiet cloud Thread can come back")
  assert.match(await evaluate(`document.querySelector('[data-thread-return-offer]').innerText`), /Bring back to this Mac[\s\S]*cloud machine ends/)
  await both("return-offer", ['[data-thread-return-offer]', '[data-run-place]'])
  await phases("hold")
  await click('[data-thread-return-offer]')
  await until(`document.querySelector('[data-thread-return="packing"]') !== null`, "packing in the cloud")
  assert.match(await evaluate(`document.querySelector('[data-run-place]').getAttribute('aria-label')`), /Coming back/)
  await both("return-packing", ['[data-thread-return]', '[data-run-place]'])
  await phases("next")
  await until(`document.querySelector('[data-thread-return="bringing"]') !== null`, "bringing it here")
  await both("return-bringing", ['[data-thread-return]'])
  await phases("run")
  await until(`document.querySelector('[data-run-place="local"]') !== null && !document.querySelector('[data-thread-return]')`, "back")
  await both("back", ['[data-run-place]', '[data-composer]'])

  // 4. A confirmed refusal stays above the composer after its toast ends; only an explicit retry starts a new move.
  await startThread("&move=busy")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await recordMoves()
  await pressMove()
  await until(`document.querySelector('[data-run-place="local"]') !== null && document.querySelector('[data-thread-move-failed]') !== null`, "confirmed local refusal")
  assert.match(await evaluate(`document.querySelector('[data-thread-move-failed]').innerText`), /Still on this Mac[\s\S]*Moves happen between turns[\s\S]*Retry move/)
  await until(`![...document.querySelectorAll('[data-sonner-toast]')].some(node => node.innerText.includes('It stayed on this Mac'))`, "transient receipt ended")
  assert.equal(await evaluate(`window.moveCalls.length`), 1, "a refused move is not retried automatically")
  await both("move-kept-here", ['[data-run-place]', '[data-composer]'])
  await evaluate(`(() => { const url = new URL(location.href); url.searchParams.delete('move'); history.replaceState(null, '', url); return true })()`)
  await phases("hold")
  await clickText('[data-thread-move-failed]', "Retry move")
  await until(`document.querySelector('[data-thread-move="packing"]') !== null`, "explicit retry started")
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-thread-move-failed]'))`), false)
  assert.equal(await evaluate(`window.moveCalls.length`), 2)
  assert.equal(await evaluate(`window.moveCalls[0].move === window.moveCalls[1].move`), false, "a deliberate retry has a new operation ID")
  await phases("run")
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "retry confirmed by moved event")

  // 4b. An early refusal returned without an event retains the actual reason, and can be dismissed without another call.
  await startThread("")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await recordMoves("refusal")
  await pressMove()
  await until(`document.querySelector('[data-thread-move-failed]') !== null`, "early returned refusal")
  assert.match(await evaluate(`document.querySelector('[data-thread-move-failed]').innerText`), /example\/private-service[\s\S]*GitHub access/)
  assert.equal(await evaluate(`document.querySelector('[data-run-place="cloud"]')`), null)
  await both("move-private-repository-refused", ['[data-thread-move-failed]', '[data-composer]'])
  await click('[data-thread-move-failed] button[aria-label="More about this"]')
  await until(`document.body.innerText.includes('Keep this Mac awake while its agents are running.')`, "full reason and local readiness guidance")
  await both("move-refusal-details", ['[role="dialog"]', '[data-thread-move-failed]'])
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await click('[data-thread-move-failed] button[aria-label="Dismiss move failure"]')
  await until(`!document.querySelector('[data-thread-move-failed]')`, "refusal dismissed")
  assert.equal(await evaluate(`window.moveCalls.length`), 1, "dismiss never starts or cancels a cloud operation")
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-run-place="local"]'))`), true)

  // 4c. A lost reply cannot establish that the Thread stayed local. Check status rejoins the same operation.
  await startThread("")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await recordMoves("lost")
  await pressMove()
  await until(`document.querySelector('[data-thread-move="unsettled"]') !== null`, "lost answer is unconfirmed")
  assert.match(await evaluate(`document.querySelector('[data-thread-move="unsettled"]').innerText`), /Move not confirmed[\s\S]*Check status/)
  assert.equal(await evaluate(`Boolean(document.querySelector('[data-thread-move-failed]'))`), false, "transport loss is not a confirmed refusal")
  assert.equal(await evaluate(`document.querySelector('[data-run-place="cloud"]')`), null)
  assert.match(await evaluate(`document.querySelector('[data-run-place]').getAttribute('aria-label')`), /Move not confirmed/)
  assert.equal(await evaluate(`document.querySelector('[data-run-place]').disabled`), true, "an unconfirmed move cannot start another move from its location chip")
  await both("move-unconfirmed", ['[data-thread-move]', '[data-composer]'])
  await phases("hold")
  await clickText('[data-thread-move="unsettled"]', "Check status")
  await until(`document.querySelector('[data-thread-move="packing"]') !== null`, "owner's phase after status check")
  assert.equal(await evaluate(`window.moveCalls.length`), 2)
  assert.equal(await evaluate(`window.moveCalls[0].move === window.moveCalls[1].move`), true, "status check keeps the original operation ID")
  await phases("run")
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "owner confirms the move after lost reply")

  // 5. A Thread at work is handed off: its chip offers it, the strip says its turn pauses, and it goes on in the cloud.
  await startThread("")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click(".composer-input")
  await type("Keep working through the failing retries")
  await enter()
  await until(`document.querySelector('[data-run-place="local"]') !== null && document.querySelector('.composer-input') !== null`, "the turn running")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer][data-thread-handoff]') !== null`, "the handoff offer")
  assert.match(await evaluate(`document.querySelector('[data-thread-move-offer]').innerText`), /Hand off to the cloud[\s\S]*turn pauses[\s\S]*goes on there/)
  await both("handoff-offer", ['[data-thread-move-offer]', '[data-run-place]'])
  await recordMoves("refusal")
  await phases("hold")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-thread-move-failed]') !== null`, "handoff refused before pausing")
  await evaluate(`import('/src/state/cloud-moves.ts').then(({threadMoveStepped}) => {
    const call = window.moveCalls[0]
    threadMoveStepped(call.conversationId, call.move, {kind: 'kept-here', reason: 'Fixture repeated refusal before pausing.'})
  })`)
  await both("handoff-refused", ['[data-thread-move-failed]', '[data-composer]'])
  await clickText('[data-thread-move-failed]', "Retry move")
  await until(`window.moveCalls.length === 2`, "handoff retry requested")
  await until(`document.querySelector('[data-thread-move="packing"]') !== null`, "packing its turn")
  assert.equal(await evaluate(`window.moveCalls[0].options.why`), "asked")
  assert.equal(await evaluate(`window.moveCalls[1].options.why`), "asked", "manual retry preserves handoff intent")
  await phases("next")
  await until(`document.querySelector('[data-thread-move="pausing"][data-thread-handoff]') !== null`, "pausing its turn")
  assert.match(await evaluate(`document.querySelector('[data-thread-move]').innerText`), /Handing off to the cloud/)
  await both("handoff-pausing", ['[data-thread-move]', '[data-run-place]'])
  await phases("next")
  await until(`document.querySelector('[data-thread-move="handing-over"]') !== null`, "handing its turn over")
  await phases("next")
  await until(`document.querySelector('[data-thread-move="resuming"][data-thread-handoff]') !== null`, "continuing in the cloud")
  await both("handoff-resuming", ['[data-thread-move]'])
  await phases("run")
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "handed off")

  // 5b. A Thread whose turn ended but left work running in the background is handed off too: that work stops, and it's told so there.
  await startThread("")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click(".composer-input")
  await type("Start the dev server in the background")
  await enter()
  await until(`document.body.innerText.includes('Finished: Start the dev server')`, "the turn ended, its work in the background")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer][data-thread-handoff]') !== null`, "the handoff offer for background work")
  assert.match(await evaluate(`document.querySelector('[data-thread-move-offer]').innerText`), /Hand off to the cloud[\s\S]*left running in the background stops[\s\S]*told what stopped/)
  await both("handoff-background-offer", ['[data-thread-move-offer]', '[data-run-place]'])
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })

  // 6. The way back stays when Codex here is older than the cloud's: one choice updates it and brings the Thread back.
  await startThread("&return=outdated")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved")
  await click('[data-run-place="cloud"]')
  await until(`document.querySelector('[data-thread-return-offer]') !== null`, "the return offer")
  await click('[data-thread-return-offer]')
  await until(`document.querySelector('[data-thread-return="outdated"]') !== null`, "the outdated notice")
  assert.match(await evaluate(`document.querySelector('[data-thread-return="outdated"]').innerText`), /stayed in the cloud[\s\S]*0\.163\.0[\s\S]*Update Codex and bring it back/)
  assert.ok(await evaluate(`document.querySelector('[data-run-place="cloud"]') !== null`), "the Thread stays in the cloud meanwhile")
  await both("return-outdated", ['[data-thread-return]', '[data-run-place]'])
  await clickText('[data-thread-return="outdated"]', "Update Codex and bring it back")
  await until(`document.querySelector('[data-harness-update="updating"]')?.innerText.includes('Updating Codex')`, "updating")
  await both("return-updating", ['[data-harness-update]'])
  await until(`document.querySelector('[data-thread-return="packing"]') !== null`, "bringing it back after the update")
  await until(`document.querySelector('[data-run-place="local"]') !== null && !document.querySelector('[data-thread-return]')`, "back after the update")

  const escape = async () => {
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
    await page.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 })
  }
  const popover = '[data-slot="popover-content"]'
  const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.innerText ?? ''`)

  // 8. Codex here older than the cloud's: said before the move, with the one choice that updates it, then moves.
  await startThread("&harnesses=behind")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-harness-behind="move"]') !== null`, "the harnesses behind the cloud's")
  assert.match(await text('[data-harness-behind]'), /Codex here is older than the cloud's[\s\S]*comes back only after Codex here is 0\.164\.0 or newer[\s\S]*Codex 0\.159\.3 here, 0\.164\.0 in the cloud[\s\S]*Update Codex to 0\.164\.0, then move[\s\S]*Move anyway/)
  assert.equal(await evaluate(`document.querySelector('[data-thread-move-offer]').tagName`), "DIV", "the move is said, its choices under it")
  await both("harness-skew-move-behind", [popover])
  await click("[data-harness-update-then]")
  await until(`document.querySelector('[data-harness-update="updating"]') !== null`, "updating before the move")
  assert.match(await text('[data-harness-update]'), /Updating Codex[\s\S]*Then it moves to the cloud/)
  assert.ok(await evaluate(`document.querySelector('[data-run-place="local"]') !== null`), "it's on this Mac while Codex updates")
  await both("harness-skew-updating", ['[data-harness-update]'])
  await until(`document.querySelector('[data-thread-move="packing"]') !== null`, "the move after the update")
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved after the update")
  await click('[data-run-place="cloud"]')
  await until(`document.querySelector('[data-thread-return-offer]') !== null`, "the return offer")
  assert.equal(await evaluate(`document.querySelector('[data-harness-behind]')`), null, "updated, nothing holds the way back")
  await escape()

  // 9. Several behind: Mako updates Codex and OpenCode; Devin is Devin.app's and Grok needs a newer Mako, each said. Moved
  // anyway, the Cloud chip says the same before the way back.
  await startThread("&harnesses=several")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-harness-behind="move"]') !== null`, "several harnesses behind")
  assert.equal(await evaluate(`document.querySelectorAll('[data-harness-behind-row]').length`), 4)
  assert.match(await text('[data-harness-behind]'), /Harnesses here are older than the cloud's[\s\S]*Update it through the Devin app; Mako checks again when you come back to this window[\s\S]*A newer Mako brings Grok 1\.0\.70: update Mako first[\s\S]*Update Codex and OpenCode, then move[\s\S]*Check again[\s\S]*Move anyway/)
  await both("harness-skew-move-several", [popover])
  await click("[data-harness-anyway]")
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved anyway")
  await click('[data-run-place="cloud"]')
  await until(`document.querySelector('[data-harness-behind="back"]') !== null`, "the way back's harnesses")
  assert.match(await text('[data-harness-behind]'), /It comes back once Codex, OpenCode, Devin and Grok here are as new as the cloud's[\s\S]*Update Codex and OpenCode, then bring it back[\s\S]*Bring back anyway/)
  await both("harness-skew-back-several", [popover])
  await escape()

  // 10. An update that fails says which and why, above the composer; the Thread stays, and can still move anyway.
  await startThread("&harnesses=failing")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-harness-update-then]') !== null`, "the update offer")
  await click("[data-harness-update-then]")
  await until(`document.querySelector('[data-harness-update="failed"]') !== null`, "the failed update")
  assert.match(await text('[data-harness-update]'), /Codex wasn't updated[\s\S]*EACCES/)
  assert.ok(await evaluate(`document.querySelector('[data-run-place="local"]') !== null`), "it stays on this Mac")
  await both("harness-skew-update-failed", ['[data-harness-update]'])
  await clickText('[data-harness-update]', "Move anyway")
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved anyway after the failed update")

  // 10b. An update that finished without moving the binary Mako runs: the strip names where it went and what Mako runs.
  await startThread("&harnesses=elsewhere")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-harness-update-then]') !== null`, "the update offer")
  await click("[data-harness-update-then]")
  await until(`document.querySelector('[data-harness-update="failed"]') !== null`, "the update that landed elsewhere")
  assert.match(await text('[data-harness-update]'), /Codex wasn't updated[\s\S]*npm installed Codex 0\.164\.0 into \/opt\/homebrew, but Mako runs \/Users\/you\/\.nvm\/versions\/node\/v24\.19\.0\/bin\/codex, still 0\.159\.3\./)
  assert.ok(await evaluate(`document.querySelector('[data-run-place="local"]') !== null`), "it stays on this Mac")
  await both("harness-update-elsewhere", ['[data-harness-update]'])
  await clickText('[data-harness-update]', "Move anyway")
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved anyway after the update that landed elsewhere")

  // 11. A Session a newer Codex wrote here than the cloud runs: the move is refused in the popover, with when it can go.
  await startThread("&harnesses=ahead")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]')?.innerText.includes("can't pick up there yet")`, "the refusal")
  assert.equal(await evaluate(`document.querySelector('[data-thread-move-offer]').disabled`), true)
  assert.match(await text('[data-thread-move-offer]'), /The cloud runs Codex 0\.164\.0, older than the 0\.165\.0 that wrote this Thread here[\s\S]*once the cloud runs 0\.165\.0 or newer/)
  await both("harness-skew-ahead", [popover])
  await escape()

  // 12. Devin, which Devin.app updates: the way back stays and says what to do; updated there, the window weighs it
  // again as it's focused, and one choice brings the Thread back.
  await startThread("&harnesses=devin&return=outdated-devin")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-harness-anyway]') !== null`, "Devin behind the cloud's")
  assert.equal(await evaluate(`document.querySelector('[data-harness-update-then]')`), null, "Mako can't update Devin.app's Devin")
  await click("[data-harness-anyway]")
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved")
  await click('[data-run-place="cloud"]')
  await until(`document.querySelector('[data-harness-behind="back"]') !== null`, "the way back's Devin")
  await click("[data-harness-anyway]")
  await until(`document.querySelector('[data-thread-return="outdated"]') !== null`, "the way back stayed")
  assert.match(await text('[data-thread-return="outdated"]'), /stayed in the cloud[\s\S]*Update Devin through the Devin app, then bring it back[\s\S]*Check again/)
  await both("harness-skew-return-devin", ['[data-thread-return]'])
  await evaluate(`import('/src/dev/mock-bridge.ts').then((mock) => { mock.mockHarnessesHere.set('devin', '3000.11.205'); window.dispatchEvent(new Event('focus')); return true })`)
  await until(`document.querySelector('[data-thread-return="ready"]') !== null`, "ready once Devin.app updated it")
  assert.match(await text('[data-thread-return="ready"]'), /Ready to come back[\s\S]*Devin here is as new as the cloud's now/)
  await both("harness-skew-return-ready", ['[data-thread-return]'])
  await clickText('[data-thread-return="ready"]', "Bring it back")
  await until(`document.querySelector('[data-run-place="local"]') !== null && !document.querySelector('[data-thread-return]')`, "back after Devin.app's update")

  // 13. The project the Thread's worktree was made from isn't on this Mac: the way back is refused before the cloud is
  // asked, the strip says so and offers the folder it moved to; chosen, the Thread comes back.
  await startThread("&return=project-gone")
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved")
  await click('[data-run-place="cloud"]')
  await until(`document.querySelector('[data-thread-return-offer]') !== null`, "the return offer")
  await click('[data-thread-return-offer]')
  await until(`document.querySelector('[data-thread-return="missing-project"]') !== null`, "the missing project notice")
  assert.match(await text('[data-thread-return="missing-project"]'), /Its project isn't on this Mac[\s\S]*Still in the cloud[\s\S]*Locate project…/)
  assert.equal(await evaluate(`document.querySelector('[data-thread-return="missing-project"] button[aria-label="Keep in the cloud"]') !== null`), true, "putting it away keeps it in the cloud")
  assert.ok(await evaluate(`document.querySelector('[data-run-place="cloud"]') !== null`), "the Thread stays in the cloud meanwhile")
  await both("return-project-missing", ['[data-thread-return]', '[data-run-place]'])
  // What it says in full: the project the host named, and the worktree it comes back into.
  await click('[data-thread-return="missing-project"] button[aria-label="More about this"]')
  await until(`document.querySelector(${JSON.stringify(popover)})?.innerText.includes('/Users/you/Projects/billing-api')`, "the missing project's detail")
  assert.match(await text(popover), /Its project, \/Users\/you\/Projects\/billing-api, isn't on this Mac anymore[\s\S]*locate it where it is now[\s\S]*retry-billing-webhooks/)
  await both("return-project-missing-detail", [popover, '[data-thread-return]'])
  await escape()
  await clickText('[data-thread-return="missing-project"]', "Locate project")
  await until(`document.querySelector('[data-run-place="local"]') !== null && !document.querySelector('[data-thread-return]')`, "back into the chosen project")

  // 14. A way back left unsettled says who it waits on, the cloud or this Mac, and asking again settles it.
  for (const waitsOn of ["cloud", "here"]) {
    await startThread(`&return=unsettled-${waitsOn}`)
    await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
    await click('[data-run-place="local"]')
    await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
    await click('[data-thread-move-offer]')
    await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved")
    await click('[data-run-place="cloud"]')
    await until(`document.querySelector('[data-thread-return-offer]') !== null`, "the return offer")
    await click('[data-thread-return-offer]')
    await until(`document.querySelector('[data-thread-return="unsettled"][data-waits-on="${waitsOn}"]') !== null`, `unsettled, waiting on ${waitsOn}`)
    assert.match(await text('[data-thread-return="unsettled"]'), waitsOn === "cloud" ? /Waiting for the cloud's answer[\s\S]*Nothing runs it yet[\s\S]*Ask again/ : /Couldn't finish coming back[\s\S]*Nothing runs it yet[\s\S]*Ask again/)
    await both(`return-unsettled-${waitsOn}`, ['[data-thread-return]', '[data-run-place]'])
    await click('[data-thread-return="unsettled"] button[aria-label="More about this"]')
    await until(`document.querySelector(${JSON.stringify(popover)})?.innerText.includes('Ask again, or Mako asks when it next starts')`, "the unsettled detail")
    await both(`return-unsettled-${waitsOn}-detail`, [popover, '[data-thread-return]'])
    await escape()
    await clickText('[data-thread-return="unsettled"]', "Ask again")
    await until(`document.querySelector('[data-run-place="local"]') !== null && !document.querySelector('[data-thread-return]')`, "back once asked again")
  }

  // 15. A Thread in the project folder moves in one step: its chip offers it, saying it goes onto its own branch first;
  // the strip's first step says so; moved, it says what came along (two repositories, files from outside its folder)
  // and what stayed (a secret). The person changes its worktree here: following stops, and the strip offers to bring
  // it back to edit here; back, merged, one file in conflict and one outside the worktree the person changed, whose
  // cloud copy is kept, the toast opening it.
  await startThread("&move=main&follow=stopped&return=merged", false)
  await until(`document.body.innerText.includes('Finished:')`, "the first turn ended")
  await click('[data-run-place="local"]')
  await until(`document.querySelector('[data-thread-move-offer]') !== null`, "the move offer")
  assert.equal(await evaluate(`document.querySelector('[data-thread-move-offer]').disabled`), false, "a quiet Thread in the project folder can move")
  assert.match(await text('[data-thread-move-offer]'), /Move to the cloud[\s\S]*own branch first[\s\S]*project folder keeps yours/)
  await both("main-checkout-offer", ['[data-thread-move-offer]', '[data-run-place]'])
  await phases("hold")
  await click('[data-thread-move-offer]')
  await until(`document.querySelector('[data-thread-move="own-branch"]') !== null`, "onto its own branch")
  assert.match(await text('[data-thread-move]'), /Moving to the cloud[\s\S]*Onto its own branch/)
  await both("main-checkout-own-branch", ['[data-thread-move]', '[data-run-place]'])
  await phases("run")
  await until(`document.querySelector('[data-run-place="cloud"]') !== null && !document.querySelector('[data-thread-move]')`, "moved")
  await toastShot("main-checkout-moved", "Moved to the cloud")
  assert.match(await evaluate(`[...document.querySelectorAll('[data-sonner-toast]')].map((node) => node.innerText).join('\\n')`), /both its repositories and 3 files from outside its folder[\s\S]*One file stayed here: credentials, a secret/)
  await until(`document.querySelector('[data-thread-follow="stopped"]') !== null`, "following stopped")
  assert.match(await text('[data-thread-follow]'), /You changed its worktree here[\s\S]*Bring back to edit here/)
  await both("follow-stopped", ['[data-thread-follow]', '[data-run-place]'])
  await clickText('[data-thread-follow]', "Bring back to edit here")
  await until(`document.querySelector('[data-run-place="local"]') !== null && !document.querySelector('[data-thread-return]')`, "back, merged")
  await toastShot("return-merged", "Back on this Mac")
  assert.match(await evaluate(`[...document.querySelectorAll('[data-sonner-toast]')].map((node) => node.innerText).join('\\n')`), /Your edits to todo\.md stayed\. retry\.ts has conflict markers: you both changed it\. The agent knows\. You changed state\.json meanwhile, so yours stayed\. billing-sync couldn't be written back: permission denied\.[\s\S]*Open the cloud's copy/)

  // Back from going away: the Thread on screen held for the account's word, run here by the person; then one Mako
  // Cloud went on with, whose own files stayed in the project folder and which took commits not yet pushed.
  const awayKey = await evaluate(`import('/src/state/acp-state.ts').then(async ({ acpStore }) => {
    const key = acpStore.get().activeKey
    ;(await import('/src/state/cloud-moves.ts')).awayHeld([key])
    return key
  })`)
  await until(`document.querySelector('[data-thread-away="held"]') !== null`, "the Thread held for the account")
  assert.match(await text('[data-thread-away]'), /Waiting to hear from Mako Cloud[\s\S]*Paused while this Mac was away[\s\S]*Run it here/)
  await both("away-held", ['[data-thread-away]', '[data-run-place]'])
  await clickText('[data-thread-away]', "Run it here")
  await until(`document.querySelector('[data-thread-away]') === null`, "run here: nothing waits")
  await evaluate(`import('/src/state/cloud-moves.ts').then((moves) => moves.checkoutStayed({ conversation: ${JSON.stringify(awayKey)}, paths: ["src/billing.ts", "retry.ts", "todo.md"], unpushed: 2 }))`)
  await until(`document.querySelector('[data-thread-away="stayed"]') !== null`, "what stayed in the project folder")
  assert.match(await text('[data-thread-away]'), /3 of its files stayed in your project folder[\s\S]*2 unpushed commits went to Mako Cloud/)
  await both("checkout-stayed", ['[data-thread-away]', '[data-run-place]'])

  // 7. Settings: handing off as this Mac sleeps, and what quitting does while agents work.
  await evaluate(`window.dispatchEvent(new CustomEvent("mako:settings", { detail: "account" })), true`)
  await until(`document.querySelector('[data-handoff-settings]') !== null && document.querySelector('[data-handoff-settings] [role="switch"]')?.getAttribute('aria-checked') === 'true'`, "the handoff settings, on by default")
  await evaluate(`document.querySelector('[data-handoff-settings]').scrollIntoView({ block: 'center' }), true`)
  await both("handoff-settings", ['[data-handoff-settings]'])
  await click('[data-handoff-settings] [role="switch"]')
  await until(`document.querySelector('[data-handoff-settings] [role="switch"]').getAttribute('aria-checked') === 'false'`, "handing off on sleep turned off")
  await clickText('[data-handoff-settings]', "Hand off")
  await until(`document.querySelector('[data-handoff-settings] [aria-pressed="true"]')?.innerText.includes('Hand off')`, "quitting hands off")
  await both("handoff-settings-changed", ['[data-handoff-settings]'])
  console.log("Thread move UI: offered from a worktree Thread's Local chip, three steps above the composer, Cloud once moved; brought back from its Cloud chip in two steps, Local once back; a confirmed refusal retained after its toast, explicitly retried under a new operation; an early returned private-repository refusal retained and dismissed; a lost reply kept unconfirmed and checked under the same operation; a failed handoff retried with its intent intact; a Thread at work handed off with its turn paused, and one with only background work; an outdated way back updated and brought back in one choice; a way back whose project isn't here refused before the cloud is asked and brought into the folder the project moved to; an unsettled way back saying who it waits on and settled by asking again; a Thread in the project folder moved in one step onto its own branch first, saying what came and what stayed, its worktree changed here stopping the follow, and its way back merged, saying what conflicts, what couldn't be written back, and opening the cloud's copy of what the person changed outside it; harnesses here older than the cloud's said before the move with the update that settles them, its progress and its failure, a Session the cloud can't resume refused before anything moves, and a way back waiting on Devin.app ready once it's updated; and the handoff settings")
  clearTimeout(watchdog)
  app.exit(0)
}
