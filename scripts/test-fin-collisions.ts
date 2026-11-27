import assert from "node:assert/strict"
import { join } from "node:path"
import { test } from "node:test"
import { COLLIDE_BURST_MS, FROM_AGENTS, sharingWords } from "@mako/host/contracts/children"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { digest, type Notice } from "@mako/host/conversations/agent-wakes"
import { FinCollisions, statedWrites, type Mate } from "@mako/host/conversations/fin-collisions"
import { meetings, overlapWhy, pathsMeet, touchesRefusal, touchPath } from "@mako/host/contracts/fin-overlap"
import { asksNobody } from "@mako/host/contracts/apexes"
import type { AgentsStartInput } from "@mako/host/contracts/agent-tools"
import type { ToolEffects } from "@mako/sessions/tool-effects"
import { AgentsWorld, type Script } from "./lib/agents-world.ts"
import { testScratch } from "./lib/test-scratch.mjs"

/*
 * Two Fins of one Apex changing the same file in one folder are named to their Apex once (`npm run
 * test:fin-collisions`): nothing told it, so it couldn't give one a workspace or run them in turn while it still
 * mattered. The rule on a clock the test moves, then through the engine: one notice a pair, never held for the Fins
 * still at work, none for different files or another folder, the Apex's own writes, a burst, and a restart.
 */

const root = testScratch("mako-fin-collisions-")

/** Time and timers the test moves: `advance` runs every timer due by then, in order, as they'd have fired. */
class FakeClock {
  at = 1_800_000_000_000
  private timers: { due: number; run: () => void }[] = []
  readonly now = () => this.at
  readonly later = (ms: number, run: () => void) => {
    const timer = { due: this.at + ms, run }
    this.timers.push(timer)
    return () => void (this.timers = this.timers.filter((each) => each !== timer))
  }
  advance(ms: number): void {
    const until = this.at + ms
    for (;;) {
      const next = this.timers.filter((timer) => timer.due <= until).sort((a, b) => a.due - b.due)[0]
      if (!next) break
      this.timers = this.timers.filter((timer) => timer !== next)
      this.at = Math.max(this.at, next.due)
      next.run()
    }
    this.at = until
  }
}

/** A Shiver of `apex` and its Fins by when each started; anyone else has no mate. */
function watch(starts: Record<string, number>) {
  const clock = new FakeClock()
  const told: { a: string; b: string; files: readonly string[]; first: boolean }[] = []
  const mates = (thread: string): Mate[] => {
    if (thread === "apex") return Object.entries(starts).map(([fin, since]) => ({ thread: fin, since }))
    const own = starts[thread]
    if (own === undefined) return []
    return [{ thread: "apex", since: own }, ...Object.entries(starts).filter(([fin]) => fin !== thread).map(([fin, since]) => ({ thread: fin, since: Math.max(own, since) }))]
  }
  const collisions = new FinCollisions({ now: clock.now, later: clock.later, mates, collided: (a, b, files, first) => told.push({ a, b, files, first }) })
  return { clock, told, collisions }
}

test("only what a call states it wrote counts: never what it saw change, read, or ran", () => {
  assert.deepEqual(statedWrites([
    { kind: "modify", path: "/r/a.ts" },
    { kind: "create", path: "/r/b.ts" },
    { kind: "write", path: "/r/c.ts" },
    { kind: "delete", path: "/r/d.ts" },
    { kind: "rename", from: "/r/e.ts", to: "/r/f.ts" },
    { kind: "modify", path: "/r/seen.ts", seen: true },
    { kind: "read", path: "/r/read.ts" },
    { kind: "command", command: "sed -i s/a/b/ /r/named.ts", named: ["/r/named.ts"] },
  ]), ["/r/a.ts", "/r/b.ts", "/r/c.ts", "/r/d.ts", "/r/e.ts", "/r/f.ts"])
})

test("two Fins writing the same file collide once; different files, and the same file again, say nothing", () => {
  const { clock, told, collisions } = watch({ one: 0, two: 0 })
  collisions.wrote("one", ["/r/a.ts"])
  collisions.wrote("two", ["/r/b.ts"])
  clock.advance(COLLIDE_BURST_MS)
  assert.equal(told.length, 0, "different files")
  collisions.wrote("two", ["/r/a.ts"])
  assert.equal(told.length, 0, "not before its burst's window")
  clock.advance(COLLIDE_BURST_MS)
  assert.deepEqual(told, [{ a: "one", b: "two", files: ["/r/a.ts"], first: true }])
  collisions.wrote("one", ["/r/a.ts"])
  collisions.wrote("two", ["/r/a.ts"])
  clock.advance(10 * COLLIDE_BURST_MS)
  assert.equal(told.length, 1, "once a pair and file, not once a write")
  assert.deepEqual(collisions.of("one").map((pair) => pair.files), [["/r/a.ts"]])
  assert.deepEqual(collisions.of("two").map((pair) => pair.files), [["/r/a.ts"]])
})

test("a write counts from the later of the two starts", () => {
  const { clock, told, collisions } = watch({ early: 0, late: 1_800_000_000_500 })
  collisions.wrote("early", ["/r/a.ts"])
  collisions.wrote("apex", ["/r/b.ts"])
  clock.advance(1_000)
  // `late` started after both writes: they're the base it began from.
  collisions.wrote("late", ["/r/a.ts", "/r/b.ts"])
  clock.advance(COLLIDE_BURST_MS)
  assert.equal(told.length, 0)
  collisions.wrote("early", ["/r/a.ts"])
  clock.advance(COLLIDE_BURST_MS)
  assert.deepEqual(told, [{ a: "early", b: "late", files: ["/r/a.ts"], first: true }])
})

test("a Fin in its own worktree writes other paths, so it collides with nobody until a merge", () => {
  const { clock, told, collisions } = watch({ shared: 0, apart: 0 })
  collisions.wrote("shared", ["/r/src/a.ts"])
  collisions.wrote("apart", ["/worktrees/apart/src/a.ts"])
  clock.advance(COLLIDE_BURST_MS)
  assert.equal(told.length, 0)
})

test("an Apex collides with its Fin", () => {
  const { clock, told, collisions } = watch({ fin: 0 })
  collisions.wrote("fin", ["/r/a.ts"])
  collisions.wrote("apex", ["/r/a.ts"])
  clock.advance(COLLIDE_BURST_MS)
  assert.deepEqual(told, [{ a: "apex", b: "fin", files: ["/r/a.ts"], first: true }])
})

test("a burst is one notice; files found after it are said as more of the same pair", () => {
  const { clock, told, collisions } = watch({ one: 0, two: 0 })
  const files = Array.from({ length: 40 }, (_, index) => `/r/src/${index}.ts`)
  collisions.wrote("one", files)
  for (const file of files) collisions.wrote("two", [file])
  clock.advance(COLLIDE_BURST_MS)
  assert.equal(told.length, 1)
  assert.deepEqual(told[0], { a: "one", b: "two", files, first: true })
  collisions.wrote("one", ["/r/late.ts"])
  collisions.wrote("two", ["/r/late.ts"])
  clock.advance(COLLIDE_BURST_MS)
  assert.deepEqual(told[1], { a: "one", b: "two", files: ["/r/late.ts"], first: false })
})

test("a Thread with no mate keeps nothing, and a write that overlaps nobody costs a map write", () => {
  const { collisions } = watch({ one: 0, two: 0 })
  collisions.wrote("alone", ["/r/a.ts", "/r/b.ts"])
  assert.equal(collisions.held, 0, "nothing is kept for a Thread in no Shiver")
  const paths = Array.from({ length: 2_000 }, (_, index) => `/r/src/${index}.ts`)
  const rounds = 50
  const began = performance.now()
  for (let round = 0; round < rounds; round += 1) for (const path of paths) collisions.wrote("one", [path])
  const each = (performance.now() - began) / (rounds * paths.length)
  console.log(`a write that overlaps nobody: ${(each * 1_000).toFixed(2)} µs`)
  assert.ok(each < 0.05, `a write that overlaps nobody took ${each} ms`)
  assert.equal(collisions.held, paths.length)
})

test("the digest names the pair, a few files and a count, and what the Apex can do; its row says the newest file", () => {
  const notice = (collision: NonNullable<Notice["collision"]>): Notice => ({
    id: "notice:collide:a:b",
    report: { id: "collide:a:b", child: ThreadIdSchema.parse("11111111-1111-4111-8111-111111111111"), status: "progress", summary: "", implicit: true, ownerGeneration: 1, at: 1 },
    label: `"tests" (Codex)`,
    fin: { name: "tests", harness: "codex" },
    from: "s",
    collision,
  })
  const text = digest([notice({ mate: "b", with: `"docs" (Claude)`, files: ["src/a.ts", "src/b.ts", "src/c.ts"], more: 37 })], "2 working.")
  assert.match(text, /1 pair changed the same files in one folder:/)
  assert.match(text, /• "tests" \(Codex\) and "docs" \(Claude\) both changed src\/a\.ts, src\/b\.ts, src\/c\.ts and 37 more\./)
  assert.match(text, /Neither was told\. Keep them apart \(a new Fin's workspace, or agents_send one to worktree_move\) or have one wait for the other/)
  assert.match(digest([notice({ mate: "apex", files: ["src/a.ts"], more: 0 })], "1 working."), /• "tests" \(Codex\) and you both changed src\/a\.ts\./)
  assert.equal(sharingWords({ with: "docs", files: ["/r/src/a.ts"], more: 0 }), "Also editing a.ts with docs")
  assert.equal(sharingWords({ files: ["/r/src/a.ts"], more: 3 }), "Also editing a.ts and 3 more with its Apex")
})

const edit = (id: string, ...paths: string[]): ToolEffects => ({ callId: id, status: "completed", effects: paths.map((path) => ({ kind: "modify" as const, path })) })

test("through the engine: two Fins in one folder are named to their Apex once, at once, and not again after a restart", async () => {
  const BURST = 300
  const wakes: string[] = []
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) {
      await turn.world.hold(turn.conversation)
      return "Done."
    }
    const spoken = turn.text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
    if (spoken.startsWith(FROM_AGENTS)) wakes.push(spoken)
    return "ok"
  }
  const collided = () => wakes.filter((text) => text.includes("changed the same files"))
  // Results that ask nothing would wait ten minutes for the Fins still at work: a collision never does.
  const world = new AgentsWorld({ root: join(root, "engine"), script, collideMs: BURST, holdMs: 10 * 60_000 })
  try {
    const apex = await world.apex("claude", "full")
    const start = async (name: string) => {
      const started = await world.agents.start(apex.caller, { brief: { objective: `Work on ${name}` }, harness: "codex", name, clientKey: name, cwd: world.root })
      assert.ok(!("refused" in started) && started.conversation)
      return started.conversation!
    }
    const [tests, docs, third] = [await start("tests"), await start("docs"), await start("third")]
    const file = (name: string) => join(world.root, "src", name)
    await until(() => [tests, docs, third].every((fin) => world.live.session(fin)?.status === "running"), "the Fins' turns began")
    const row = (name: string) => world.agents.roster(apex.conversation).find((entry) => entry.child?.name === name)?.child?.sharing
    // The first result wakes the Apex, so what asks nothing after it is held for the Fins still at work.
    world.release(third)
    await until(() => wakes.length === 1, "the first result wakes the Apex")
    // Different files, and a Fin writing in a worktree of its own: nothing.
    world.agents.wrote(tests, edit("1", file("a.ts")))
    world.agents.wrote(docs, edit("2", file("b.ts"), join(root, "worktrees", "docs", "src", "a.ts")))
    await pause(4 * BURST)
    assert.equal(collided().length, 0, "different files, or the same file in another folder, say nothing")
    assert.equal(row("tests"), undefined)
    // The same file, then a burst of them.
    world.agents.wrote(docs, edit("3", file("a.ts")))
    world.agents.wrote(tests, edit("4", ...Array.from({ length: 5 }, (_, index) => file(`${index}.ts`))))
    world.agents.wrote(docs, edit("5", ...Array.from({ length: 5 }, (_, index) => file(`${index}.ts`))))
    await until(() => collided().length === 1, "the Apex hears of the pair while both still work")
    assert.match(collided()[0]!, /1 pair changed the same files in one folder:\n {2}• "(tests|docs)" \(Codex\) and "(tests|docs)" \(Codex\) both changed src\/a\.ts, src\/0\.ts, src\/1\.ts and 3 more\./)
    assert.equal(row("tests"), "Also editing 4.ts and 5 more with docs")
    assert.equal(row("docs"), "Also editing 4.ts and 5 more with tests")
    // Once: the same files written again say nothing, and more files ride the next digest without a wake.
    world.agents.wrote(tests, edit("6", file("a.ts"), file("late.ts")))
    world.agents.wrote(docs, edit("7", file("a.ts"), file("late.ts")))
    await pause(4 * BURST)
    assert.equal(collided().length, 1, "once a pair")
    await world.restart()
    world.agents.wrote(tests, edit("8", file("a.ts")))
    world.agents.wrote(docs, edit("9", file("a.ts")))
    await pause(6 * BURST)
    assert.equal(collided().length, 1, "a restart doesn't say the pair again")
    assert.equal(wakes.filter((text) => text.includes("both changed")).length, 1, "nor in any digest its Fins' own news sent since")
    world.release(tests)
    world.release(docs)
  } finally {
    await world.close()
  }
})

test("through the engine: an Apex that writes a file its Fin wrote is told it is the one", async () => {
  const BURST = 300
  const wakes: string[] = []
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) {
      await turn.world.hold(turn.conversation)
      return "Done."
    }
    const spoken = turn.text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
    if (spoken.startsWith(FROM_AGENTS)) wakes.push(spoken)
    return "ok"
  }
  const world = new AgentsWorld({ root: join(root, "apex"), script, collideMs: BURST })
  try {
    const apex = await world.apex("claude", "full")
    const path = join(world.root, "src", "a.ts")
    // What the Apex wrote before it started the Fin is the base the Fin began from.
    world.agents.wrote(apex.conversation, edit("0", path))
    await pause(20)
    const started = await world.agents.start(apex.caller, { brief: { objective: "Run the tests" }, harness: "codex", name: "tests", clientKey: "tests", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation)
    const fin = started.conversation!
    world.agents.wrote(fin, edit("1", path))
    await pause(4 * BURST)
    assert.equal(wakes.length, 0, "a write before the Fin started doesn't count")
    world.agents.wrote(apex.conversation, edit("2", path))
    await until(() => wakes.length === 1, "the Apex is told")
    assert.match(wakes[0]!, /• "tests" \(Codex\) and you both changed src\/a\.ts\./)
    assert.equal(world.agents.roster(apex.conversation).find((entry) => entry.child?.name === "tests")?.child?.sharing, "Also editing a.ts with its Apex")
    world.release(fin)
  } finally {
    await world.close()
  }
})

// ── A start's touches against the Fins at work (`startOverlap`): refused once, then sent, sequenced or started anyway. ──

test("touches meet as files and directories, repo-relative", () => {
  assert.equal(touchPath("./src//a.ts/"), "src/a.ts")
  assert.equal(touchPath("src/x/../a.ts"), "src/a.ts")
  assert.equal(touchPath("."), "")
  assert.equal(touchPath("../outside.ts"), undefined, "a path that climbs out of the repository names nothing in it")
  assert.ok(pathsMeet("src", "src/a.ts"), "a directory holds its files")
  assert.ok(pathsMeet("src/a.ts", "src"), "either way round")
  assert.ok(!pathsMeet("src/a", "src/ab.ts"), "a prefix isn't a directory")
  assert.ok(pathsMeet("", "anything.ts"), "the repository's root holds everything")
  assert.deepEqual(meetings(["src", "docs/x.md"], ["src/a.ts", "src/b.ts", "lib/c.ts"]), ["src/a.ts", "src/b.ts"], "the narrower path is named")
  assert.equal(touchesRefusal({ touches: Array.from({ length: 51 }, (_, index) => `${index}.ts`) })?.includes("at most 50"), true)
  assert.equal(touchesRefusal({ touches: ["x".repeat(301)] })?.includes("300"), true)
  assert.equal(touchesRefusal({ proceed: "" })?.includes("proceed"), true)
  assert.equal(touchesRefusal({ touches: ["src/a.ts"], proceed: "separate functions" }), undefined)
})

test("the refusal names who, which files, what it costs and the three ways on", () => {
  const why = overlapWhy([{ name: "docs", how: "editing", files: ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"] }], false)
  assert.equal(why, `fin:docs is editing src/a.ts, src/b.ts, src/c.ts and 1 more, which this Fin would touch. Two Fins on the same files load the same context twice and meet at merge. Send this to fin:docs with agents_send, start it after: ["docs"], or start it anyway with proceed: "<why these don't collide>". Keep this clientKey when you start it again.`)
  assert.match(overlapWhy([{ how: "changed", files: ["src/a.ts"] }], false), /^You changed src\/a\.ts, which this Fin would touch\. In your folder it would edit them under you\. Do it yourself, or start it anyway with proceed/)
  assert.match(overlapWhy([{ name: "api", how: "will edit", files: ["api.ts"], branch: "fin/api" }], true), /In its own worktree it would conflict with that work at merge\. .*start it after: \["api"\] or on its branch \(workspace base: "fin\/api"\)/)
})

test("a start refused for overlap asks nobody again under its key, and only that start", () => {
  assert.equal(asksNobody("agents_start", { clientKey: "a" }), false, "a start asks as it always did")
  assert.equal(asksNobody("agents_start", { clientKey: "a" }, ["a"]), true, "its retry under the refused key doesn't")
  assert.equal(asksNobody("agents_start", { clientKey: "b" }, ["a"]), false, "another start still asks")
})

test("through the engine: a start's touches are checked against its Fins at work, its own changes and nothing finished", async () => {
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) {
      await turn.world.hold(turn.conversation)
      return "Done."
    }
    return "ok"
  }
  const world = new AgentsWorld({ root: join(root, "overlap"), script })
  try {
    const apex = await world.apex("claude", "full")
    const start = (name: string, more: Partial<AgentsStartInput> = {}) =>
      world.agents.start(apex.caller, { brief: { objective: `Work on ${name}` }, harness: "codex", name, clientKey: name, cwd: world.root, ...more })
    const docs = await start("docs", { touches: ["src/a.ts", "src/b.ts"] })
    assert.ok(!("refused" in docs) && docs.conversation, JSON.stringify(docs))

    // Refused, naming the Fin, the files and every way on.
    const refused = await start("tests", { touches: ["./src/a.ts", "README.md"] })
    assert.ok("refused" in refused && refused.refused === "overlap", JSON.stringify(refused))
    assert.match(refused.why, /^fin:docs is editing src\/a\.ts, which this Fin would touch\./)
    assert.match(refused.why, /agents_send/)
    assert.match(refused.why, /after: \["docs"\]/)
    assert.match(refused.why, /proceed: /)
    assert.deepEqual(world.agents.startRetries(apex.conversation), ["tests"], "its key's retry asks the person nothing")

    // A directory holds the files in it.
    const directory = await start("src-sweep", { touches: ["src"] })
    assert.ok("refused" in directory && directory.refused === "overlap" && /src\/a\.ts, src\/b\.ts/.test(directory.why), JSON.stringify(directory))

    // Without touches, nothing is checked.
    const reader = await start("reader")
    assert.ok(!("refused" in reader), JSON.stringify(reader))

    // The same key with after goes through: a refusal is never that key's answer.
    const sequenced = await start("tests", { touches: ["src/a.ts"], after: ["docs"] })
    assert.ok(!("refused" in sequenced) && sequenced.state === "queued", JSON.stringify(sequenced))

    // The same key with proceed starts it, and keeps the reason on its record and its row.
    const anyway = await start("src-sweep", { touches: ["src"], proceed: "docs edits comments only; this renames a function" })
    assert.ok(!("refused" in anyway) && anyway.conversation, JSON.stringify(anyway))
    const edge = world.store.edges().children(world.store.journalPlacement(apex.conversation)!.thread).find((each) => each.name === "src-sweep")
    assert.equal(edge?.asked.proceed, "docs edits comments only; this renames a function")
    assert.deepEqual(edge?.asked.touches, ["src"])
    assert.equal(world.agents.roster(apex.conversation).find((entry) => entry.child?.name === "src-sweep")?.child?.proceed, "docs edits comments only; this renames a function")

    // What a Fin at work changed counts, though it declared nothing of it.
    world.agents.wrote(reader.conversation!, edit("r1", join(world.root, "lib", "c.ts")))
    const changed = await start("lib", { touches: ["lib/c.ts"] })
    assert.ok("refused" in changed && changed.why.startsWith("fin:reader changed lib/c.ts"), JSON.stringify(changed))

    // What the caller changed itself counts, said as its own.
    world.agents.wrote(apex.conversation, edit("o1", join(world.root, "own.ts")))
    const own = await start("own", { touches: ["own.ts"] })
    assert.ok("refused" in own && own.why.startsWith("You changed own.ts"), JSON.stringify(own))

    // A finished Fin, and a stopped one, count for nothing.
    world.release(reader.conversation!)
    await until(() => world.agents.roster(apex.conversation).find((entry) => entry.child?.name === "reader")?.child?.state?.kind === "ended", "reader finished")
    const afterFinish = await start("lib-again", { touches: ["lib/c.ts"] })
    assert.ok(!("refused" in afterFinish), JSON.stringify(afterFinish))
    await world.agents.stop(apex.caller, { child: "docs", reason: "test" })
    await world.agents.stop(apex.caller, { child: "src-sweep", reason: "test" })
    await world.agents.stop(apex.caller, { child: "lib-again", reason: "test" })
    const afterStop = await start("docs-two", { touches: ["src/a.ts"] })
    assert.ok(!("refused" in afterStop), JSON.stringify(afterStop))
    await world.agents.stop(apex.caller, { child: "all", reason: "done" })
  } finally {
    await world.close()
  }
})

test("through the engine: starting on a sibling's branch, or after it, isn't an overlap; starts in one turn meet each other", async () => {
  const script: Script = async (turn) => {
    if (turn.text.includes("You're fin:")) {
      await turn.world.hold(turn.conversation)
      return "Done."
    }
    return "ok"
  }
  const world = new AgentsWorld({ root: join(root, "overlap-branch"), script })
  try {
    const apex = await world.apex("claude", "full")
    const start = (name: string, more: Partial<AgentsStartInput> = {}) =>
      world.agents.start(apex.caller, { brief: { objective: `Work on ${name}` }, harness: "codex", name, clientKey: name, cwd: world.root, ...more })
    const first = await start("first")
    assert.ok(!("refused" in first) && first.conversation)
    // Queued after first, on a branch of its own: a start on that branch is sequenced on it.
    const api = await start("api", { touches: ["api.ts"], after: ["first"], workspace: { branch: "fin/api" } })
    assert.ok(!("refused" in api) && api.state === "queued", JSON.stringify(api))
    const onIt = await start("api-tests", { touches: ["api.ts"], after: ["first"], workspace: { base: "fin/api" } })
    assert.ok(!("refused" in onIt), JSON.stringify(onIt))
    const apart = await start("api-docs", { touches: ["api.ts"], after: ["first"], workspace: { base: "main" } })
    assert.ok("refused" in apart && apart.refused === "overlap", JSON.stringify(apart))
    assert.match(apart.why, /fin:api will edit api\.ts.*In its own worktree it would conflict with that work at merge\..*on its branch \(workspace base: "fin\/api"\)/)
    // Two starts made together, as an Apex starts its pieces in one turn: the second meets the first before either has an edge.
    const [one, two] = await Promise.all([start("left", { touches: ["shared.ts"] }), start("right", { touches: ["shared.ts"] })])
    assert.ok(!("refused" in one), JSON.stringify(one))
    assert.ok("refused" in two && two.why.startsWith("fin:left will edit shared.ts"), JSON.stringify(two))
    await world.agents.stop(apex.caller, { child: "all", reason: "done" })
  } finally {
    await world.close()
  }
})

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
async function until(check: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${what}`)
    await pause(50)
  }
}
