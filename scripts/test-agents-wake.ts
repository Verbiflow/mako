import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { AFTER_START, AGENT_TOOLS, WAIT_LIMIT_MS, type AgentsStarted, type AgentsStartInput, type AgentsStartResult } from "@mako/host/contracts/agent-tools"
import { childState, ReportSchema, ReportStatusSchema, reportRoute, StartModeSchema, ThreadParentSchema, WakeOnSchema, type ReportStatus, type StartMode, type WakeOn } from "@mako/host/contracts/agents"
import { actionNotice } from "@mako/host/contracts/operation-recovery"
import { SessionIdSchema } from "@mako/host/contracts/thread-identity"
import { agentToolSchema } from "@mako/host/conversations/agent-tools"
import { FROM_AGENTS, WAKE_COALESCE_MS } from "@mako/host/conversations/agent-wakes"
import { childWord, DIGEST_RESTART_HINT } from "@mako/host/contracts/children"
import { AgentsWorld, HARNESSES, type Script } from "./lib/agents-world.ts"

/**
 * How an Apex hears back from its children (`npm run test:agents-wake`): each
 * start's mode (`background`, `wait`) and wake setting (`decisions`,
 * `finish`, `never`), on the real store, `LiveConversations` and `Agents`
 * with every harness a scripted model. A burst is one wake; `finish` and
 * `never` send questions to the person and never drop them; a `wait` answers
 * its result or a question within its window, and past it the result starts
 * the Apex's next turn, settled-only, on all six harnesses, across a restart,
 * and once only when the start is repeated.
 */
const root = mkdtempSync(join(tmpdir(), "mako-agents-wake-"))

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function until(what: string, done: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await delay(10)
  }
}

function world(name: string, script: Script): AgentsWorld {
  return new AgentsWorld({ root: join(root, name), script })
}

function spoken(text: string): string {
  return text.replace(/^<mako-local-control>[\s\S]*?<\/mako-local-control>\n\n/, "")
}

function wakesOf(w: AgentsWorld, conversation: string) {
  return w.prompts.filter((prompt) => prompt.conversation === conversation && spoken(prompt.text).startsWith(FROM_AGENTS)).map((prompt) => ({ ...prompt, text: spoken(prompt.text) }))
}

function started(answer: AgentsStartResult | undefined): AgentsStarted {
  assert.ok(answer && !("refused" in answer), JSON.stringify(answer))
  return answer
}

const RESULT = "There are 12 files.\nsrc holds 9 and test holds 3.\nNothing else is tracked."

/** Where each report goes, for every mode and wake setting, and whose a question reads as. */
function routes(): void {
  const table = {
    "background decisions": { done: "apex", failed: "apex", blocked: "apex", "needs-input": "apex", progress: "none" },
    "background finish": { done: "apex", failed: "apex", blocked: "person", "needs-input": "person", progress: "none" },
    "background never": { done: "none", failed: "none", blocked: "person", "needs-input": "person", progress: "none" },
    "wait decisions": { done: "apex", failed: "apex", blocked: "apex", "needs-input": "apex", progress: "none" },
    "wait finish": { done: "apex", failed: "apex", blocked: "person", "needs-input": "person", progress: "none" },
    "wait never": { done: "apex", failed: "apex", blocked: "person", "needs-input": "person", progress: "none" },
  } satisfies Record<`${StartMode} ${WakeOn}`, Record<ReportStatus, ReturnType<typeof reportRoute>>>
  for (const mode of StartModeSchema.options)
    for (const wake of WakeOnSchema.options)
      for (const status of ReportStatusSchema.options) assert.equal(reportRoute({ mode, wake }, status), table[`${mode} ${wake}`][status], `${mode} ${wake} ${status}`)
  assert.equal(reportRoute({}, "needs-input"), "apex", "absent means background and decisions")
  const apex = SessionIdSchema.parse(randomUUID())
  const edge = (wake?: WakeOn) => ThreadParentSchema.parse({
    child: randomUUID(), parent: randomUUID(), parentSession: apex, name: "c", role: "worker", origin: "started",
    asked: { brief: { objective: "x" }, ...(wake && { wake }) }, op: "start:c", startedBy: { kind: "agent", session: apex }, createdAt: 1,
  })
  const asking = { latest: ReportSchema.parse({ id: "r", child: randomUUID(), status: "needs-input", summary: "Which?", question: "Main or next?", ownerGeneration: 1, at: 1 }) }
  const ask = { kind: "report", id: "r" } as const
  assert.deepEqual(childState(edge(), { source: "live" }, asking), { kind: "blocked", question: "Main or next?", on: "lead", ask })
  assert.deepEqual(childState(edge("finish"), { source: "live" }, asking), { kind: "blocked", question: "Main or next?", on: "person", ask }, "a question its Apex won't hear is the person's")
  assert.deepEqual(childState(edge("never"), { source: "live" }, asking), { kind: "blocked", question: "Main or next?", on: "person", ask })
  const passed = { latest: { ...asking.latest, for: "person" as const, options: [{ label: "main" }, { label: "next" }], recommended: 1 } }
  assert.deepEqual(childState(edge(), { source: "live" }, passed), { kind: "blocked", question: "Main or next?", on: "person", ask: { ...ask, options: passed.latest.options, recommended: 1 } }, "a question its Apex left to the person is theirs, with its options")
}

/** The model sees both choices on every door, each said when to use. */
function described(): void {
  const start = AGENT_TOOLS.find((tool) => tool.verb === "start")!
  const { properties } = z.looseObject({
    properties: z.record(z.string(), z.looseObject({ anyOf: z.array(z.looseObject({ const: z.string() })).optional(), description: z.string().optional() })),
  }).parse(agentToolSchema(start).toJSONSchema())
  const values = (field: string) => properties[field]?.anyOf?.map((choice) => choice.const).sort()
  assert.deepEqual(values("mode"), ["background", "wait"])
  assert.deepEqual(values("wake"), ["decisions", "finish", "never"])
  for (const field of ["mode", "wake", "timeoutMs"]) assert.equal(properties[field]?.description, start.mcp.fields[field], `${field} is described to the model`)
  assert.match(start.mcp.description, /mode wait only when your next step can't go on without its result/)
  assert.match(start.mcp.fields.mode!, /Never wait on work that can run while you do other things/)
  assert.match(start.mcp.fields.wake!, /questions go to the person/)
  assert.match(start.mcp.description, new RegExp(`${WAIT_LIMIT_MS / 1000} seconds`))
}

/** Five children finishing within a second wake their idle apex at most twice: the first as soon as it has settled, with what came beside it, then the rest as one digest. */
async function burst(): Promise<void> {
  const w = world("burst", async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    await delay(Math.random() * 800)
    return `Done: ${turn.harness} checked its part.`
  })
  try {
    const apex = await w.apex("codex")
    for (const [i, harness] of HARNESSES.slice(1).entries())
      started(await w.agents.start(apex.caller, { brief: { objective: `Check part ${i}` }, harness, name: `part-${i}`, clientKey: `p${i}`, cwd: w.root }))
    await w.settle()
    const wakes = wakesOf(w, apex.conversation)
    assert.ok(wakes.length >= 1 && wakes.length <= 2, `at most two wakes for the burst, the first report's and everything else's: ${wakes.length}`)
    // Each Fin's report is in exactly one of them.
    for (let part = 0; part < 5; part += 1) assert.equal(wakes.filter((wake) => wake.text.includes(`"part-${part}"`)).length, 1, `part-${part} is reported once`)
    assert.equal(w.store.undeliveredReports().length, 0)
  } finally {
    await w.close()
  }
}

/**
 * An Apex with three Fins, "a", "b" and "c", each at work until `finish` lets it end with its reply as its result. "a"
 * has finished and its Apex has heard it, at once; "b" has finished since and its result is held for "c", still at work.
 */
async function heldFor(name: string, holdMs: number, fail?: string) {
  const fins = new Map<string, string>()
  const w = new AgentsWorld({
    root: join(root, name),
    holdMs,
    script: async (turn) => {
      // A turn a restart cut runs again in the next host, without its brief: it's still that Fin's.
      const fin = /You're fin:(\w+),/.exec(turn.text)?.[1] ?? [...fins].find(([, conversation]) => conversation === turn.conversation)?.[0]
      if (!fin) return "ok"
      fins.set(fin, turn.conversation)
      await turn.world.hold(turn.conversation)
      if (fin === fail) {
        const told = await turn.world.agents.report(turn.caller, { status: "failed", summary: `${fin} couldn't finish its part.`, clientKey: "r" })
        assert.ok(!("refused" in told), JSON.stringify(told))
        return "Reported."
      }
      return `Done: ${fin} checked its part.`
    },
  })
  const apex = await w.apex("codex")
  const children = new Map<string, string>()
  for (const fin of ["a", "b", "c"]) children.set(fin, started(await w.agents.start(apex.caller, { brief: { objective: `Check part ${fin}` }, harness: "claude", name: fin, clientKey: fin, cwd: w.root })).child!)
  await until(`${name}: every Fin at work`, () => fins.size === 3 && [...fins.values()].every((conversation) => w.live.session(conversation)?.status === "running"))
  const finish = (fin: string) => w.release(fins.get(fin)!)
  const wakes = () => wakesOf(w, apex.conversation)
  const waiting = () => (w.live.held(apex.conversation)?.requests ?? []).filter((request) => request.digest && (request.status === "queued" || request.status === "held"))
  const first = Date.now()
  finish("a")
  await until(`${name}: the first result's wake`, () => wakes().length === 1, 3_000)
  assert.ok(wakes()[0]!.at - first < 1_500, `${name}: the first result goes at once: ${wakes()[0]!.at - first} ms`)
  await until(`${name}: the Apex's turn on it to end`, () => w.live.session(apex.conversation)?.status !== "running")
  const before = Date.now()
  finish("b")
  await until(`${name}: the second result to wait in its Apex's queue`, () => waiting().length === 1)
  const held = waiting()[0]!
  assert.equal(held.status, "held", `${name}: held, not sent`)
  assert.ok(held.wake?.since !== undefined && held.wake.since >= before && held.wake.at === held.wake.since + holdMs, `${name}: until its time, counted from when it was held: ${JSON.stringify(held.wake)}`)
  assert.deepEqual(held.digest!.notices.map((notice) => notice.fin.name), ["b"])
  return { w, apex, fins, children, finish, wakes, waiting, held: { id: held.id, at: held.wake.at, since: held.wake.since } }
}

/**
 * Results that ask nothing, after the first: held in the Apex's queue for the Fins still at work, and sent as one
 * digest by what ends the hold, on the real queue with its hold shortened. Meanwhile the Fin reads as done to the
 * person and to its Apex's own reads, and its edge isn't closed.
 */
async function heldResults(): Promise<void> {
  // The last Fin finishes: both results go as one digest. Until then the held one woke nobody, and read as done.
  {
    const f = await heldFor("held-tree-quiet", 60_000)
    try {
      await delay(WAKE_COALESCE_MS + 500)
      assert.equal(f.wakes().length, 1, "past the burst's window the held result still woke nobody")
      const b = f.w.agents.roster(f.apex.conversation).find((agent) => agent.child?.thread === f.children.get("b"))
      assert.deepEqual(b?.child?.state, { kind: "ended", outcome: "done" }, "the roster the person's card reads says it finished, before any digest")
      const read = await f.w.agents.read(f.apex.caller, { child: "b" })
      assert.ok(!("refused" in read) && /Done: b checked its part\./.test(JSON.stringify(read)), `agents_read gives its result meanwhile: ${JSON.stringify(read).slice(0, 300)}`)
      assert.equal(f.w.agents.keptOpenBy(f.children.get("b")!), "finished too recently")
      assert.equal(f.w.store.undeliveredReports().length, 0, "its report is its digest's, in the queue")
      const at = Date.now()
      f.finish("c")
      await until("the held result and the last one to go", () => f.wakes().length === 2, 5_000)
      assert.ok(f.wakes()[1]!.at - at < 1_500, `as the last Fin finishes, not at the hold's time: ${f.wakes()[1]!.at - at} ms`)
      assert.match(f.wakes()[1]!.text, /2 finished:[\s\S]*"b"[\s\S]*"c"/, "one digest for both")
      await f.w.settle()
      assert.equal(f.wakes().length, 2, "three results, two digests")
      assert.equal(f.waiting().length, 0)
    } finally {
      await f.w.close()
    }
  }
  // A Fin fails: the failure goes as it would alone, and takes the held result with it.
  {
    const f = await heldFor("held-failure", 60_000, "c")
    try {
      const at = Date.now()
      f.finish("c")
      await until("the failure to go", () => f.wakes().length === 2, 5_000)
      assert.ok(f.wakes()[1]!.at - at < 1_500, `at once: ${f.wakes()[1]!.at - at} ms`)
      assert.match(f.wakes()[1]!.text, /"b"/, "with the held result")
      assert.match(f.wakes()[1]!.text, /"c" \([^)]*\) failed/, "and the failure")
      await f.w.settle()
      assert.equal(f.wakes().length, 2)
    } finally {
      await f.w.close()
    }
  }
  // The person writes to the Apex: the held news goes inside their turn, and wakes it for nothing more.
  {
    const f = await heldFor("held-person", 60_000)
    try {
      f.w.say(f.apex.conversation, "How is it going?")
      await until("the person's turn", () => f.w.prompts.some((prompt) => prompt.conversation === f.apex.conversation && spoken(prompt.text).startsWith("How is it going?")))
      const turn = spoken(f.w.prompts.find((prompt) => prompt.conversation === f.apex.conversation && spoken(prompt.text).startsWith("How is it going?"))!.text)
      assert.match(turn, /Done: b checked its part\./, "their turn carries the held result")
      assert.equal(f.w.live.snapshot(f.apex.conversation)!.requests.find((request) => request.id === f.held.id)?.joinedInto !== undefined, true, "folded into their message")
      f.finish("c")
      await f.w.settle()
      assert.equal(f.wakes().filter((wake) => /Done: b checked its part\./.test(wake.text)).length, 0, "and no digest says it again")
    } finally {
      await f.w.close()
    }
  }
  // Nobody finishes, asks or writes: it goes when its time comes, counted from when it was held.
  {
    const f = await heldFor("held-bound", 1_500)
    try {
      await until("the held result to go at its time", () => f.wakes().length === 2, 5_000)
      const late = f.wakes()[1]!.at - f.held.at
      assert.ok(late >= 0 && late < 1_000, `at its time, not before: ${late} ms after`)
      assert.match(f.wakes()[1]!.text, /1 finished:[\s\S]*"b"/)
    } finally {
      await f.w.close()
    }
  }
  // The host restarts while it's held: it's still held, until the time the last host gave it, and goes once.
  for (const how of ["restart", "crashed"] as const) {
    const f = await heldFor(`held-${how}`, 6_000)
    try {
      await f.w[how]()
      const kept = f.w.live.snapshot(f.apex.conversation)!.requests.find((request) => request.id === f.held.id)!
      assert.equal(kept.status, "held", `${how}: still held`)
      assert.deepEqual(kept.wake, { at: f.held.at, after: "digest", since: f.held.since }, `${how}: until the same time, not one counted from the new host's start`)
      await until(`${how}: the held result to go`, () => f.wakes().some((wake) => /"b"/.test(wake.text)), 10_000)
      const went = f.wakes().find((wake) => /"b"/.test(wake.text))!
      assert.ok(went.at >= f.held.at && went.at - f.held.at < 1_000, `${how}: at its time: ${went.at - f.held.at} ms after`)
      // The last Fin's turn, which the exit cut, went on in this host: it ends now.
      f.finish("c")
      await f.w.settle(2_600, 30_000)
      assert.equal(f.wakes().filter((wake) => /Done: b checked its part\./.test(wake.text)).length, 1, `${how}: heard once`)
      assert.equal(f.w.store.undeliveredReports().length, 0)
    } finally {
      await f.w.close()
    }
  }
}

/** `finish`: a question goes to the person, never to the Apex; once the person answers, the result wakes the Apex. */
async function finishOnly(): Promise<void> {
  const children = new Set<string>()
  const w = world("finish", async (turn) => {
    if (turn.text.includes("You're fin:")) {
      children.add(turn.conversation)
      const told = await turn.world.agents.report(turn.caller, { status: "needs-input", summary: "The branch isn't named.", question: "Main or next?", clientKey: "q" })
      assert.ok(!("refused" in told), JSON.stringify(told))
      return "I asked."
    }
    return children.has(turn.conversation) ? "Merged it into main." : "ok"
  })
  try {
    const apex = await w.apex("claude")
    const answer = started(await w.agents.start(apex.caller, { brief: { objective: "Merge the fix" }, harness: "codex", wake: "finish", clientKey: "m", cwd: w.root }))
    assert.match(answer.next, /its questions go to the person/)
    await w.settle()
    assert.equal(wakesOf(w, apex.conversation).length, 0, "the question didn't wake the Apex")
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    assert.deepEqual(listed.children[0]!.state, { kind: "blocked", question: "Main or next?", on: "person", ask: { kind: "report", id: `report:${answer.child}:q` } }, "it's the person's to answer")
    assert.equal(w.store.edges().of(answer.child!)!.asked.wake, "finish", "the edge keeps what was asked")
    w.say(answer.conversation!, "Main.")
    await w.settle()
    const wakes = wakesOf(w, apex.conversation)
    assert.equal(wakes.length, 1, "its result wakes the Apex")
    assert.match(wakes[0]!.text, /1 finished:\n {2}• "[^"]+" \(Codex\) done: Merged it into main\./)
    assert.doesNotMatch(wakes[0]!.text, /needs a decision/)
  } finally {
    await w.close()
  }
}

/**
 * A turn that ends on progress waiting on nothing Mako watches is heard by its Apex, once, as ended without a result,
 * with the Fin's last words: never its result, since it never said it was done (fin-models on #868, 2026-11-16, was
 * said "done" on a promise), and never a question, which would reach the person once its Apex left it. Progress on a
 * pull request the watch reads stays quiet until its outcome wakes the Fin (loop-holds' "ready for your review" on
 * #810, 2026-11-15, woke nobody).
 */
async function progressThenTurnEnd(): Promise<void> {
  const w = new AgentsWorld({
    root: join(root, "progress-turn-end"),
    readPull: async () => null,
    script: async (turn) => {
      if (!turn.text.includes("You're fin:")) return "ok"
      const say = (summary: string, waitingOn?: Parameters<typeof turn.world.agents.report>[1]["waitingOn"]) =>
        turn.world.agents.report(turn.caller, { status: "progress", summary, ...(waitingOn && { waitingOn }), clientKey: "said" })
      if (turn.text.includes("Review")) { await say("Ready for review at 1a2b3c4."); return "" }
      if (turn.text.includes("Merge")) { await say("Reviewed; it needs merging.", [{ kind: "person", what: "merge" }]); return "Over to the person." }
      if (turn.text.includes("Drop prep")) {
        await say("Reviewed; it needs merging.", [{ kind: "person", what: "merge" }])
        // Then a word that names no wait, the #810 case: ready, nothing watched, so its end is its result.
        await turn.world.agents.report(turn.caller, { status: "progress", summary: "Ready for review at 9f8e7d6.", clientKey: "said-ready" })
        return ""
      }
      if (turn.text.includes("Other prep")) {
        await say("Reviewed; it needs merging.", [{ kind: "person", what: "merge" }])
        await turn.world.agents.report(turn.caller, { status: "progress", summary: "Waiting on the deploy window.", waitingOn: [{ kind: "other", text: "the deploy window" }], clientKey: "said-other" })
        return "Waiting on the deploy window."
      }
      if (turn.text.includes("Reword")) {
        await say("Reviewed; it needs merging.", [{ kind: "person", what: "merge" }])
        // The same wait said again in other words, as narration does: nothing new for its Apex.
        await turn.world.agents.report(turn.caller, { status: "progress", summary: "Still waiting for the person to merge it.", waitingOn: [{ kind: "person", what: "merge" }], clientKey: "said-again" })
        return "Over to the person."
      }
      await say("Pushed; CI runs.", [{ kind: "pull-request", ref: "acme/app#5", until: "checks" }])
      return "Waiting on CI."
    },
  })
  try {
    const apex = await w.apex("codex")
    for (const [name, objective] of [["review", "Review prep"], ["merge", "Merge prep"], ["reword", "Reword prep"], ["drop", "Drop prep"], ["other", "Other prep"], ["ci", "CI prep"]])
      started(await w.agents.start(apex.caller, { brief: { objective }, harness: "claude", name, clientKey: name, cwd: w.root }))
    await w.settle()
    const wakes = wakesOf(w, apex.conversation)
    const heard = wakes.map((wake) => wake.text).join("\n")
    assert.match(heard, /"review" \(Claude\): Nothing it waits on will wake it\. Its last words: "Ready for review at 1a2b3c4\."/, `progress then a silent turn end is said as ended without a result, never done: ${heard}`)
    assert.match(heard, /"merge" \(Claude\): Reviewed; it needs merging\. · waiting on the person to merge/, "a first wait on the person wakes the Apex as it's said")
    assert.equal(heard.match(/• "merge"/g)?.length, 1, "and once: its turn's end says nothing more")
    assert.doesNotMatch(heard, /"ci"/, "progress on a pull request the watch reads stays quiet")
    assert.ok(wakes.length >= 1 && wakes.length <= 2, `the burst wakes the Apex once or twice: ${wakes.length}`)
    const results = (name: string) => w.store.reportsOf(w.store.edges().all.find((edge) => edge.name === name)!.child).filter((report) => report.implicit)
    assert.equal(results("drop").length, 1, "a person wait, then progress naming no wait: its turn's end is its result")
    assert.equal(results("other").length, 1, "a person wait, then a wait in other words: its turn's end is its result")
    assert.match(heard, /"drop" \(Claude\): Nothing it waits on will wake it\. Its last words: "Ready for review at 9f8e7d6\."/, "and its Apex hears it")
    assert.match(heard, /"other" \(Claude\): Nothing it waits on will wake it\. Its last words: "Waiting on the deploy window\."/)
    assert.equal(heard.match(/• "reword"/g)?.length, 1, "a wait said again in other words wakes the Apex once")
    const reword = w.store.reportsOf(w.store.edges().all.find((edge) => edge.name === "reword")!.child)
    assert.deepEqual(reword.map((report) => [report.status, report.implicit ?? false]), [["progress", false], ["progress", false]], "and its turn's end adds no result")
    assert.equal(heard.match(/• "review"/g)?.length, 1, "once")
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    const kind = (name: string) => listed.children.find((child) => child.name === name)?.state
    assert.equal(childWord(kind("review")!), "Ended without a result", "its row never says done")
    // The first of the burst goes at once and alone, so the three are counted across its digests, each named once.
    assert.equal(heard.match(/• "[^"]+" \(Claude\): Nothing it waits on will wake it\./g)?.length, 3, "three ended without a result, apart from what finished")
    assert.equal(kind("ci")?.kind, "idle", "the CI one waits")
    const merge = w.store.reportsOf(w.store.edges().all.find((edge) => edge.name === "merge")!.child)
    assert.deepEqual(merge.map((report) => [report.status, report.implicit ?? false]), [["progress", false]], "no turn-end result after a wait that woke the Apex")
  } finally {
    await w.close()
  }
}

/**
 * The digest a long turn's focus window steers in is taken from the queue once: a host that crashes while the harness
 * holds that steer never sends those results a second time, and drops none of them.
 */
async function focusSteerAcrossCrash(): Promise<void> {
  await focusCrash("held")
  await focusCrash("taken")
}

/** `held`: the host crashes while the harness still holds the steer. `taken`: the harness takes it and the host crashes at once. */
async function focusCrash(how: "held" | "taken"): Promise<void> {
  const w = new AgentsWorld({
    root: join(root, `focus-crash-${how}`),
    focusMs: 300,
    steering: { claude: { lands: "step", hears: "at its next step", holds: true } },
    script: async (turn) => {
      if (turn.text.includes("You're fin:")) return `Done: ${turn.text.includes("Part one") ? "part one" : "part two"} checked.`
      if (spoken(turn.text) === "go") {
        for (const [key, objective] of [["one", "Part one"], ["two", "Part two"]])
          started(await turn.world.agents.start(turn.caller, { brief: { objective }, harness: "codex", name: key, clientKey: key, cwd: turn.world.root }))
        await turn.world.hold(turn.conversation)
        return "Planned."
      }
      return "ok"
    },
  })
  try {
    const apex = await w.apex("claude", "full")
    w.say(apex.conversation, "go")
    await until("both results", () => w.store.edges().all.every((edge) => w.store.reportsOf(edge.child, 0).length > 0) && w.store.edges().all.length === 2)
    await delay(800)
    const digests = () => w.live.snapshot(apex.conversation)!.requests.filter((request) => request.digest)
    assert.ok(digests().length >= 1, "the results wait as a digest while the Apex works")
    if (how === "taken") assert.ok(w.answerSteer(apex.conversation, { kind: "accepted" }), "the harness takes the focus steer")
    await w.crashed()
    await w.settle(500, 30_000, "ignore")
    const heard = [...w.prompts.filter((prompt) => prompt.conversation === apex.conversation), ...w.steers.filter((steer) => steer.conversation === apex.conversation)].map((entry) => entry.text).join("\n")
    // Never twice. A digest whose steer the crash left unknown fails closed (delivery-queue rule 15): it isn't sent again,
    // and the turn that goes on is told reports may have arrived around the restart.
    const once = ["one", "two"].map((name) => heard.split(`• "${name}" (Codex)`).length - 1)
    assert.ok(once.every((count) => count <= 1), `no result reached its Apex twice across the crash: ${heard}`)
    if (once.some((count) => count === 0)) assert.ok(heard.includes(DIGEST_RESTART_HINT), `one not heard is said to have maybe arrived around the restart: ${heard}`)
    if (how === "taken") assert.ok(once.every((count) => count === 1), `a steer the harness took is heard, once each: ${heard}`)
  } finally {
    await w.close()
  }
}

/** `never`: nothing wakes the Apex, across a restart too; its report is there to read, and a question is the person's. */
async function never(): Promise<void> {
  const w = world("never", async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    if (turn.text.includes("Ask")) {
      await turn.world.agents.report(turn.caller, { status: "blocked", summary: "No key.", question: "Which signing key?", clientKey: "q" })
      return "Blocked."
    }
    return "Indexed 4,000 symbols."
  })
  try {
    const apex = await w.apex("opencode")
    const quiet = started(await w.agents.start(apex.caller, { brief: { objective: "Index the repo" }, harness: "grok", name: "index", wake: "never", clientKey: "i", cwd: w.root }))
    assert.match(quiet.next, /Nothing it reports wakes you/)
    started(await w.agents.start(apex.caller, { brief: { objective: "Ask about the key" }, harness: "devin", name: "sign", wake: "never", clientKey: "s", cwd: w.root }))
    await w.settle()
    assert.equal(wakesOf(w, apex.conversation).length, 0)
    assert.equal(w.store.undeliveredReports().length, 0, "nothing waits to wake it later")
    const read = await w.agents.read(apex.caller, { child: "index" })
    assert.ok("text" in read && /Indexed 4,000 symbols/.test(read.text), "the Apex reads it when it wants")
    const listed = await w.agents.list(apex.caller, {})
    assert.ok("children" in listed)
    const sign = listed.children.find((strip) => strip.name === "sign")!
    assert.deepEqual(sign.state, { kind: "blocked", question: "Which signing key?", on: "person", ask: { kind: "report", id: `report:${sign.child}:q` } }, "the question reaches the person")
    await w.restart()
    await w.settle()
    assert.equal(wakesOf(w, apex.conversation).length, 0, "a restart doesn't wake it either")
  } finally {
    await w.close()
  }
}

/** An Apex whose turn starts a child with `mode: "wait"`: `go` starts it, and the script keeps the answer. */
function waitingApex(input: Omit<AgentsStartInput, "cwd" | "clientKey"> & { clientKey?: string }, child: Script, after?: (turn: Parameters<Script>[0]) => Promise<void>) {
  const answers: AgentsStartResult[] = []
  const script: Script = async (turn) => {
    if (turn.text === "go") {
      answers.push(await turn.world.agents.start(turn.caller, { clientKey: "w", ...input, cwd: turn.world.root }))
      await after?.(turn)
      return "Noted."
    }
    if (spoken(turn.text).startsWith(FROM_AGENTS)) return "Going on."
    return child(turn)
  }
  return { answers, script }
}

/** The result comes within the window: the start answers it in full, and no wake follows. */
async function waitSettles(): Promise<void> {
  const { answers, script } = waitingApex({ brief: { objective: "Count the files" }, harness: "codex", mode: "wait" }, async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    await delay(300)
    await turn.world.agents.report(turn.caller, { status: "done", summary: RESULT, artifacts: [{ kind: "file", ref: "counts.txt" }], clientKey: "r" })
    // Its turn goes on after the report: an answer that waited for the turn's end never comes.
    await turn.world.hold(turn.conversation)
    return "Reported."
  })
  const w = world("wait-settles", script)
  try {
    const apex = await w.apex("claude")
    w.say(apex.conversation, "go")
    await until("the answer while the child's turn goes on", () => answers.length === 1)
    const answer = started(answers[0])
    assert.equal(w.live.session(answer.conversation!)?.status, "running", "it answered as the result came, while the child's turn went on")
    w.release(answer.conversation!)
    assert.deepEqual(answer.waited, { outcome: "result", report: { status: "done", summary: RESULT, artifacts: [{ kind: "file", ref: "counts.txt" }] } }, "the whole report, not its first line")
    assert.match(answer.next, /its report is above/)
    await w.settle()
    assert.equal(wakesOf(w, apex.conversation).length, 0, "the Apex heard it in the answer, so nothing wakes it")
    assert.equal(w.store.undeliveredReports().length, 0)
  } finally {
    await w.close()
  }
}

/** A question ends the wait at once, its words in the answer; once answered, the result is the Apex's next turn. */
async function waitAsks(wake: "decisions" | "finish"): Promise<void> {
  const children = new Set<string>()
  const { answers, script } = waitingApex({ brief: { objective: "Merge the fix" }, harness: "cursor", mode: "wait", wake }, async (turn) => {
    if (turn.text.includes("You're fin:")) {
      children.add(turn.conversation)
      await delay(150)
      await turn.world.agents.report(turn.caller, { status: "needs-input", summary: "The branch isn't named.", question: "Main or next?", clientKey: "q" })
      return "I asked."
    }
    return children.has(turn.conversation) ? "Merged into main. CI is green." : "ok"
  })
  const w = world(`wait-asks-${wake}`, script)
  try {
    const apex = await w.apex("codex")
    w.say(apex.conversation, "go")
    // A wait the question didn't end answers "pending" at its limit.
    await until("the answer", () => answers.length === 1, WAIT_LIMIT_MS + 10_000)
    const answer = started(answers[0])
    assert.equal(answer.waited?.outcome, "question", "the question ended the wait, not its limit")
    assert.ok(answer.waited?.outcome === "question")
    assert.equal(answer.waited.question, "Main or next?")
    assert.equal(answer.waited.answers, wake === "decisions" ? "you" : "the person")
    await w.settle()
    assert.equal(wakesOf(w, apex.conversation).length, 0, "the question was told in the answer, once")
    w.say(answer.conversation!, "Main.")
    await w.settle()
    const wakes = wakesOf(w, apex.conversation)
    assert.equal(wakes.length, 1)
    assert.match(wakes[0]!.text, /^\[mako · from your Fins, not the person\]\nThe result you waited for:\n {2}• "[^"]+" \(Cursor\) done:\n {4}Merged into main\. CI is green\./)
  } finally {
    await w.close()
  }
}

/**
 * The window ends first: the answer says the turn ends, and the result starts the Apex's next turn, in full, soon after
 * it comes: alone, ahead of a background report 500 ms behind it, which `WAKE_COALESCE_MS` would have joined to it.
 */
async function waitTimesOut(): Promise<void> {
  const kids = new Map<string, string>()
  const { answers, script } = waitingApex({ brief: { objective: "Count the files" }, harness: "grok", name: "count", mode: "wait", timeoutMs: 300 }, async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    const name = turn.text.includes("You're fin:count") ? "count" : "lint"
    kids.set(name, turn.conversation)
    await turn.world.hold(turn.conversation)
    if (name === "lint") return "Lint is clean."
    await turn.world.agents.report(turn.caller, { status: "done", summary: RESULT, clientKey: "r" })
    return "Reported."
  }, async (turn) => {
    started(await turn.world.agents.start(turn.caller, { brief: { objective: "Run lint" }, harness: "codex", name: "lint", clientKey: "l", cwd: turn.world.root }))
  })
  const w = world("wait-times-out", script)
  try {
    const apex = await w.apex("devin")
    const began = Date.now()
    w.say(apex.conversation, "go")
    // Past `WAIT_LIMIT_MS` the window was the limit's, not its own.
    await until("the answer, before the wait's limit", () => answers.length === 1, WAIT_LIMIT_MS - 1_000)
    assert.ok(Date.now() - began >= 300, "the window held its 300 ms")
    const answer = started(answers[0])
    assert.deepEqual(answer.waited, { outcome: "pending" })
    assert.match(answer.next, /End your turn now: its result starts your next turn/)
    assert.equal(w.live.session(answer.conversation!)?.status, "running", "a timeout never stops the child")
    await until("the Apex's turn to end", () => w.live.session(apex.conversation)?.status === "ready" && kids.size === 2)
    w.release(kids.get("count")!)
    await until("the result waiting to wake the Apex", () => w.agents.wakes.pending() > 0 || wakesOf(w, apex.conversation).length > 0)
    setTimeout(() => w.release(kids.get("lint")!), 500)
    // The report may reach the Apex as a wake or, while the woken turn runs, a steer.
    const heard = () => [...wakesOf(w, apex.conversation), ...w.steers.filter((steer) => steer.conversation === apex.conversation)]
    await until("lint's report reaching the Apex", () => heard().some((each) => /Lint is clean/.test(each.text)))
    const waited = wakesOf(w, apex.conversation)[0]
    assert.match(waited!.text, /The result you waited for:\n {2}• "count" \(Grok\) done:\n {4}There are 12 files\.\n {4}src holds 9 and test holds 3\.\n {4}Nothing else is tracked\./)
    assert.doesNotMatch(waited!.text, /Lint is clean/, "the result went alone, ahead of a report 500 ms behind it")
    assert.ok(heard().some((each) => /"lint" \(Codex\) done: Lint is clean\./.test(each.text)))
    await w.settle()
    assert.equal(wakesOf(w, apex.conversation).filter((wake) => /waited for/.test(wake.text)).length, 1)
  } finally {
    await w.close()
  }
}

/** An Apex still at work on a step-steer harness: the result it waited for is never steered in; a background child's report is. */
/** A busy apex whose harness refuses the steer: the report isn't lost, it starts the Apex's next turn. */
async function refusedSteer(): Promise<void> {
  let child = ""
  const w = new AgentsWorld({ root: join(root, "refused-steer"), refuseSteers: true, script: async (turn) => {
    if (turn.text === "go") {
      started(await turn.world.agents.start(turn.caller, { brief: { objective: "Run lint" }, harness: "codex", name: "lint", clientKey: "l", cwd: turn.world.root }))
      await turn.world.hold(turn.conversation)
      return "Noted."
    }
    if (spoken(turn.text).startsWith(FROM_AGENTS)) return "Going on."
    child = turn.conversation
    // A question is what a working Apex is steered with (a finished result waits for its turn's end, FOCUS_MS).
    const asked = await turn.world.agents.report(turn.caller, { status: "needs-input", summary: "Two configs.", question: "Which lint config?", clientKey: "q" })
    assert.ok(!("refused" in asked), JSON.stringify(asked))
    return "Asked."
  } })
  try {
    const apex = await w.apex("claude")
    w.say(apex.conversation, "go")
    await until("the child's report", () => child !== "" && w.store.reportsOf(w.store.edges().all[0]!.child, 0).length === 1)
    await delay(WAKE_COALESCE_MS + 500)
    assert.equal(wakesOf(w, apex.conversation).length, 0, "no turn starts while the Apex's runs")
    assert.equal(w.agents.wakes.pending(), 1, "the refused digest still waits")
    const held = w.live.snapshot(apex.conversation)?.control?.actions ?? []
    assert.equal(held.at(-1)?.state.kind, "not-accepted", "the harness refused it")
    assert.equal(actionNotice(held, []), undefined, "and the person hears nothing of a steer Mako sent by itself")
    w.release(apex.conversation)
    await until("the next turn", () => wakesOf(w, apex.conversation).length === 1)
    assert.match(wakesOf(w, apex.conversation)[0]!.text, /"lint" \(Codex\) is asking: Which lint config\?/)
    await w.settle()
    assert.equal(w.store.undeliveredReports().length, 0)
  } finally {
    await w.close()
  }
}

async function waitNeverSteers(): Promise<void> {
  const kids = new Map<string, string>()
  const { answers, script } = waitingApex({ brief: { objective: "Count the files" }, harness: "codex", name: "count", mode: "wait", timeoutMs: 200 }, async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    kids.set(turn.text.includes("You're fin:count") ? "count" : "lint", turn.conversation)
    await turn.world.hold(turn.conversation)
    return turn.text.includes("You're fin:count") ? RESULT : "Lint is clean."
  }, async (turn) => {
    started(await turn.world.agents.start(turn.caller, { brief: { objective: "Run lint" }, harness: "codex", name: "lint", clientKey: "l", cwd: turn.world.root }))
    await turn.world.hold(turn.conversation)
  })
  const w = world("wait-never-steers", script)
  try {
    const apex = await w.apex("claude")
    w.say(apex.conversation, "go")
    await until("both children", () => answers.length === 1 && kids.size === 2)
    w.release(kids.get("count")!)
    w.release(kids.get("lint")!)
    await delay(WAKE_COALESCE_MS + 500)
    assert.equal(w.steers.length, 0, "neither result is steered into the running turn: the Apex is left to think (FOCUS_MS)")
    assert.equal(wakesOf(w, apex.conversation).length, 0, "and neither starts a turn while one runs")
    w.release(apex.conversation)
    await until("the next turn", () => wakesOf(w, apex.conversation).length >= 1)
    await w.settle()
    const heard = wakesOf(w, apex.conversation).map((wake) => wake.text).join("\n")
    assert.match(heard, /The result you waited for:\n {2}• "count" \(Codex\) done:\n {4}There are 12 files\./)
    assert.match(heard, /"lint" \(Codex\) done: Lint is clean\./, "the background result goes at the turn's end too")
    assert.equal(w.steers.length, 0)
  } finally {
    await w.close()
  }
}

/** An approval the person answers (the Apex isn't on full access) ends the wait too, and says it's the person's. */
async function waitOnApproval(): Promise<void> {
  const { answers, script } = waitingApex({ brief: { objective: "Install the deps" }, harness: "codex", mode: "wait" }, async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    await delay(100)
    turn.world.live.observe({ type: "live-permission", request: { id: "npm-ci", observationId: "npm-ci-1", sessionId: turn.conversation, title: "Run npm ci", options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" }] } })
    await turn.world.hold(turn.conversation)
    return "Installed."
  })
  const w = world("wait-approval", script)
  try {
    const apex = await w.apex("opencode", "auto")
    w.say(apex.conversation, "go")
    // The child holds its turn: a wait the approval didn't end would answer "pending" at its limit.
    await until("the answer", () => answers.length === 1, WAIT_LIMIT_MS + 10_000)
    const answer = started(answers[0])
    assert.ok(answer.waited?.outcome === "question", JSON.stringify(answer.waited))
    assert.equal(answer.waited.answers, "the person")
    assert.match(answer.waited.question, /npm ci/)
    assert.match(answer.next, /asks the person/)
    w.release(answer.conversation!)
  } finally {
    await w.close()
  }
}

/** Every harness as the Apex: past the window, the result starts its next turn, and no steer carries it. */
async function sixHarnesses(): Promise<void> {
  for (const harness of HARNESSES) {
    const { answers, script } = waitingApex({ brief: { objective: "Count the files" }, harness: HARNESSES[(HARNESSES.indexOf(harness) + 1) % HARNESSES.length], mode: "wait", timeoutMs: 100 }, async (turn) => {
      if (!turn.text.includes("You're fin:")) return "ok"
      await delay(400)
      return RESULT
    })
    const w = world(`six-${harness}`, script)
    try {
      const apex = await w.apex(harness)
      w.say(apex.conversation, "go")
      await until(`${harness}'s answer`, () => answers.length === 1)
      assert.deepEqual(started(answers[0]).waited, { outcome: "pending" })
      await until(`${harness}'s next turn`, () => wakesOf(w, apex.conversation).length === 1)
      assert.match(wakesOf(w, apex.conversation)[0]!.text, /The result you waited for:[\s\S]*There are 12 files\.\n {4}src holds 9/, harness)
      await w.settle()
      assert.equal(wakesOf(w, apex.conversation).length, 1, harness)
      assert.equal(w.steers.length, 0, harness)
    } finally {
      await w.close()
    }
  }
}

/** The host restarts while the Apex's turn waits: the Apex still hears the child's result, once. */
async function waitAcrossRestart(): Promise<void> {
  let host = 1
  let child = ""
  const { answers, script } = waitingApex({ brief: { objective: "Count the files" }, harness: "codex", mode: "wait" }, async (turn) => {
    if (turn.conversation !== child && !turn.text.includes("You're fin:")) return "ok"
    child = turn.conversation
    if (host === 1) await turn.world.hold(turn.conversation)
    return RESULT
  })
  const w = world("wait-restart", script)
  try {
    const apex = await w.apex("claude")
    w.say(apex.conversation, "go")
    await until("the child's turn", () => child !== "" && w.live.session(child)?.status === "running")
    host = 2
    await w.restart()
    await w.settle(2_600, 30_000)
    const inline = answers.filter((answer) => !("refused" in answer) && answer.waited?.outcome === "result").length
    const woken = wakesOf(w, apex.conversation).filter((wake) => /There are 12 files/.test(wake.text)).length
    assert.equal(inline + woken, 1, `the Apex heard the result once (inline ${inline}, woken ${woken})`)
    assert.equal(w.store.undeliveredReports().length, 0)
  } finally {
    await w.close()
  }
}

/** A start repeated with its key after the result came (a resumed run calls again): the result again, and no wake for it. */
async function repeatAnswersAgain(): Promise<void> {
  let child = ""
  const { answers, script } = waitingApex({ brief: { objective: "Count the files" }, harness: "codex", mode: "wait", timeoutMs: 100 }, async (turn) => {
    if (!turn.text.includes("You're fin:")) return "ok"
    child = turn.conversation
    await turn.world.hold(turn.conversation)
    return RESULT
  }, async (turn) => {
    await until("the child", () => child !== "")
    turn.world.release(child)
    await until("its report", () => turn.world.store.reportsOf(turn.world.store.edges().all[0]!.child, 0).length === 1)
    answers.push(await turn.world.agents.start(turn.caller, { brief: { objective: "Count the files" }, harness: "codex", mode: "wait", clientKey: "w", cwd: turn.world.root }))
  })
  const w = world("wait-repeat", script)
  try {
    const apex = await w.apex("cursor")
    w.say(apex.conversation, "go")
    await w.settle()
    assert.equal(answers.length, 2)
    assert.deepEqual(started(answers[0]).waited, { outcome: "pending" })
    const again = started(answers[1])
    assert.ok(again.deduped)
    assert.equal(again.waited?.outcome, "result")
    assert.equal(wakesOf(w, apex.conversation).length, 0, "the repeat's answer carried it, so it doesn't wake the Apex too")
  } finally {
    await w.close()
  }
}

/** A background start answers at once, as before. */
async function backgroundAnswersAtOnce(): Promise<void> {
  const w = world("background", (turn) => turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => "ok") : "ok")
  try {
    const apex = await w.apex("codex")
    // The child holds its turn, so a start that waited for it would answer "pending" at the wait's limit, or never.
    let timer: ReturnType<typeof setTimeout> | undefined
    const never = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("a background start still waited on its child past the wait's limit")), WAIT_LIMIT_MS + 10_000)
    })
    const answer = started(await Promise.race([w.agents.start(apex.caller, { brief: { objective: "Hold" }, harness: "claude", clientKey: "b", cwd: w.root }), never]).finally(() => clearTimeout(timer)))
    assert.equal(answer.waited, undefined)
    assert.equal(answer.next, AFTER_START)
    w.release(answer.conversation!)
  } finally {
    await w.close()
  }
}

try {
  routes()
  described()
  await backgroundAnswersAtOnce()
  await burst()
  await heldResults()
  await finishOnly()
  await progressThenTurnEnd()
  await focusSteerAcrossCrash()
  await never()
  await waitSettles()
  await waitAsks("decisions")
  await waitAsks("finish")
  await waitTimesOut()
  await waitNeverSteers()
  await refusedSteer()
  await waitOnApproval()
  await sixHarnesses()
  await waitAcrossRestart()
  await repeatAnswersAgain()
  console.log("agents wake: ok")
} finally {
  rmSync(root, { recursive: true, force: true })
}
