import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { z } from "zod"
import { AGENT_TOOLS, LEGACY_SHIVER_SCOPE, ORCHESTRATION_INSTRUCTIONS, type AgentsApexes, type AgentsShiver } from "@mako/host/contracts/agent-tools"
import type { AgentCaller, Report } from "@mako/host/contracts/agents"
import { agentWords, apexNote, FROM_AGENTS, fromAgent, fromApex, YOUR_APEX } from "@mako/host/contracts/children"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { threadHandle } from "@mako/host/contracts/thread-handles"
import { agentToolSchema, agentToolText } from "@mako/host/conversations/agent-tools"
import { AgentWakes, digest, finishedLine, type Notice } from "@mako/host/conversations/agent-wakes"
import { FIN_REPORTS_MAX, readFinReports } from "@mako/host/contracts/fin-reports"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * What an Apex and its Fins tell each other, and what each costs
 * (`npm run test:orch-comms`): every tool's answer is its JSON on one line,
 * every field kept; a finished Fin's digest line carries its first paragraph
 * and every artifact's ref, and says how much more `agents_read` gives; and
 * a Fin reads its Apex and the other Fins it started (`agents_list` with
 * `scope: shiver`), from typed state, as its brief tells it it can; and an Apex
 * reads the person's other Apexes (`scope: apexes`) without waking them, and
 * messages one, which hears it as Mako's words, queued, and replies once,
 * whenever the host stops on the way; a Fin messages none.
 */
const root = mkdtempSync(join(tmpdir(), "mako-orch-comms-"))
const CHILD = ThreadIdSchema.parse("6b0c3c2e-5f8a-4d39-9a43-1d1b4c0f2a11")

function report(summary: string, extra: Partial<Report> = {}): Report {
  return { id: `report:${CHILD}:${summary.length}`, child: CHILD, status: "done", summary, ownerGeneration: 1, at: 1, ...extra }
}
const notice = (summary: string, extra: Partial<Report> = {}): Notice => ({ id: `notice:${summary.length}`, report: report(summary, extra), label: `"docs" (Codex)`, fin: { name: "docs", harness: "codex" }, from: "s" })

async function until(what: string, done: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await done())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function compactAnswers(): void {
  const answer = { children: [{ child: "c1", name: "docs", harness: "codex", origin: "started", state: { kind: "working", step: "Edit README.md" }, startedAt: 1 }], tree: { running: 1, started: 1, of: { running: 20, started: 100 } } }
  const text = agentToolText(answer)
  assert.ok(!text.includes("\n"), "an answer is one line")
  assert.deepEqual(JSON.parse(text), answer, "every field kept")
  assert.ok(text.length < JSON.stringify(answer, null, 2).length * 0.8, "indentation gone")
  const refused = agentToolText({ refused: "no-parent", why: "No Apex." })
  assert.equal(refused, `refused: no-parent\n{"refused":"no-parent","why":"No Apex."}`, "a refusal's first line names it")
}

function finishedLines(): void {
  assert.equal(finishedLine(report("Merged it into main.")), "Merged it into main.", "a short report goes whole")
  assert.equal(finishedLine(report("")), "it finished.")
  assert.equal(finishedLine(report("", { status: "failed" })), "it failed.")
  const long = `## Summary\n\nThe parser now   reads\nquoted fields.\n\n## Test plan\n- ${"x".repeat(300)}`
  assert.equal(finishedLine(report(long)), `The parser now reads quoted fields. (+${(long.length - "The parser now reads quoted fields.".length).toLocaleString("en-US")} chars)`, "its first paragraph past the heading, on one line, and how much more there is")
  const wall = "word ".repeat(400).trim()
  const line = finishedLine(report(wall))
  assert.ok(line.startsWith("word word") && line.includes("…") && line.endsWith(" chars)") && line.length < 560, "a paragraph past the line's room is cut")
  const text = digest([notice("Opened the PR. Its CI is green.", {
    artifacts: [{ kind: "pull-request", ref: "https://example.com/acme/pull/7", label: "PR #7" }, { kind: "file", ref: "docs/report.md" }],
  })], "0 working, 1 ended.")
  assert.match(text, /1 finished:\n {2}• "docs" \(Codex\) done: Opened the PR\. Its CI is green\.\n {4}pull-request: https:\/\/example\.com\/acme\/pull\/7 \(PR #7\)\n {4}file: docs\/report\.md\n/, "every artifact by its ref, its label beside it")
}

async function shiver(): Promise<void> {
  const world = new AgentsWorld({
    root: join(root, "shiver"),
    script: async (turn) => {
      if (turn.text.includes("hold")) await turn.world.hold(turn.conversation)
      return "ok"
    },
  })
  try {
    const apex = await world.apex("codex")
    const start = async (name: string, harness: string, objective: string, branch?: string, role?: "lead") => {
      const started = await world.agents.start(apex.caller, { brief: { objective }, harness, name, clientKey: name, cwd: world.root, ...(branch && { workspace: { branch } }), ...(role && { role }) })
      assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
      return started.conversation!
    }
    const api = await start("api", "claude", "Port the handlers to the new router (hold). Keep the old routes.", "router-port")
    const docs = await start("docs", "cursor", "Write the router's docs.")
    const lead = await start("review", "codex", "Lead the review of the router port. Two reviewers.", undefined, "lead")
    await until("the docs and the review to end their first turns, the port to hold", async () => {
      const listed = await world.agents.list(apex.caller, {})
      const kind = (name: string) => "children" in listed ? listed.children.find((child) => child.name === name)?.state.kind : undefined
      return kind("docs") === "ended" && kind("review") === "ended" && kind("api") === "working"
    })

    const brief = world.prompts.find((prompt) => prompt.conversation === docs)!.text
    assert.ok(brief.includes("agents_list with scope shiver shows your Shiver: your Apex and the other Fins it started."), "its brief says it can read its Shiver")
    const oldBrief = `${fromAgent(YOUR_APEX)}\nYou're fin:docs, a Fin: another Thread, your Apex, started you for one piece of work. It reads your reports, not this conversation. agents_list with scope ${LEGACY_SHIVER_SCOPE} shows it and the other Fins it started.\n\nWrite the router's docs.`
    assert.equal(agentWords(oldBrief)?.body, "Write the router's docs.", "a brief from before the Shiver reads the same")
    assert.equal(agentWords(brief.slice(brief.indexOf(fromAgent(YOUR_APEX))))?.body, "Write the router's docs.", "the person's card of the brief leaves its lines for the Fin out")
    const earlier = `${fromAgent(YOUR_APEX)}\nYou're fin:docs, a Fin: another Thread, your Apex, started you for one piece of work. It reads your reports, not this conversation.\n\nWrite the router's docs.`
    assert.equal(agentWords(earlier)?.body, "Write the router's docs.", "a brief an earlier build wrote reads the same")

    world.say(apex.conversation, "hold while they work")
    await until("the Apex's turn to run", async () => {
      const seen = await world.agents.list(world.caller(docs), { scope: "shiver" })
      return "shiver" in seen && seen.apex.working
    })
    const seen = await world.agents.list(world.caller(docs), { scope: "shiver" })
    if (!("shiver" in seen)) throw new Error(`no shiver: ${JSON.stringify(seen)}`)
    const view: AgentsShiver = seen
    assert.equal(view.you, "docs")
    assert.equal(view.apex.working, true, "its Apex's turn is running")
    assert.equal(view.apex.harness, "Codex")
    assert.equal(view.apex.asked, undefined, "a top Apex was asked nothing by an Apex")
    assert.deepEqual(view.shiver.map((mate) => mate.name), ["api", "review"], "the others, not itself")
    const port = view.shiver.find((mate) => mate.name === "api")!
    assert.equal(port.harness, "Claude")
    assert.equal(port.branch, "router-port")
    assert.equal(port.topic, "Port the handlers to the new router (hold).")
    assert.equal(port.state.kind, "working", "the port still works")
    assert.ok(!("direct" in port), "the person's words to a Fin stay its own")
    const shiverText = agentToolText({ ...view })
    assert.ok(shiverText.length < 900, `the Shiver of two in ${shiverText.length} characters`)
    // An agent of a build before the Shiver still asks with scope crew, and reads the same view.
    assert.deepEqual(await world.agents.list(world.caller(docs), { scope: LEGACY_SHIVER_SCOPE }), seen, "scope crew is scope shiver")

    world.release(apex.conversation)
    world.release(api)
    await world.settle(600, 20_000, "ignore")
    const done = await world.agents.list(world.caller(docs), { scope: "shiver" })
    assert.ok("shiver" in done && done.apex.working === false && done.shiver.find((mate) => mate.name === "api")!.state.kind === "ended", "read again, it stands as they stand now")

    // A message to a sibling it can't send goes to its Apex instead, waking it, and reaches the sibling only as the
    // Apex passes it on. Before, the send was refused and the message went nowhere: handoffs stalled until someone
    // relayed them by hand.
    const apexHeard = (said: string) => world.prompts.some((prompt) => prompt.conversation === apex.conversation && prompt.text.includes(said))
    const apiHeard = world.prompts.filter((prompt) => prompt.conversation === api).length
    const relayed = await world.agents.send(world.caller(docs), { to: "api", text: "The docs need the router's new error codes: please list them.", clientKey: "relay-codes" })
    assert.ok("refused" in relayed && relayed.refused === "relayed", JSON.stringify(relayed))
    assert.match(relayed.why, /api .*is your sibling.*went to your Apex instead.*nothing reached api directly/)
    await until("the Apex to hear the relayed message", async () => apexHeard("The docs need the router's new error codes"))
    const relay = world.prompts.filter((prompt) => prompt.conversation === apex.conversation).at(-1)!.text
    assert.ok(relay.includes("hands work to another Fin:") && /"docs" \(Cursor\) → api \(a message it couldn't send\):/.test(relay), relay)
    assert.ok(relay.includes("agents_send to each passes it on."), "and how to pass it on")
    assert.equal(world.prompts.filter((prompt) => prompt.conversation === api).length, apiHeard, "nothing reached the sibling itself")
    const again = await world.agents.send(world.caller(docs), { to: "api", text: "The docs need the router's new error codes: please list them.", clientKey: "relay-codes" })
    assert.ok("refused" in again && again.refused === "relayed")
    await world.settle(600, 20_000, "ignore")
    assert.equal(world.prompts.filter((prompt) => prompt.text.includes("The docs need the router's new error codes")).length, 1, "a repeat of its key is relayed once")

    // Progress that hands work to another Fin is a handoff, and wakes the Apex; ordinary progress stays quiet, even
    // when it uses a word that's also a Fin's name.
    const handoff = await world.agents.report(world.caller(docs), { status: "progress", summary: "Docs drafted. Hand the review slot to fin:api once the port lands.", clientKey: "handoff-review" })
    assert.ok(!("refused" in handoff) && handoff.delivered === "notice", JSON.stringify(handoff))
    await until("the Apex to hear the handoff", async () => apexHeard("Hand the review slot to fin:api"))
    const field = await world.agents.report(world.caller(docs), { status: "progress", summary: "The error-code table is yours to fill in.", handoff: { to: "api" }, clientKey: "handoff-field" })
    assert.ok(!("refused" in field) && field.delivered === "notice", "a handoff said with its field wakes the Apex")
    await until("the Apex to hear the field's handoff", async () => apexHeard("The error-code table is yours to fill in."))
    const nobody = await world.agents.report(world.caller(docs), { status: "progress", summary: "Over to them.", handoff: { to: "nobody" }, clientKey: "handoff-nobody" })
    assert.ok("refused" in nobody && nobody.refused === "unknown-child", "a handoff to no Fin of its Apex is refused")
    // Mentions aren't handoffs: a sibling's bare name, as a word or not, or its Thread.
    const quiet = await world.agents.report(world.caller(docs), { status: "progress", summary: "Started the review of section 2.", clientKey: "quiet-review" })
    assert.ok(!("refused" in quiet) && quiet.delivered === "none", "a word that's also a Fin's name isn't a handoff")
    const mention = await world.agents.report(world.caller(docs), { status: "progress", summary: `Waiting on api's PR (${world.store.edges().all.find((edge) => edge.name === "api")!.child}) before the examples.`, clientKey: "quiet-mention" })
    assert.ok(!("refused" in mention) && mention.delivered === "none", "a Fin mentioned by its name or Thread isn't handed anything")
    const plain = await world.agents.report(world.caller(docs), { status: "progress", summary: "Half the pages are written.", clientKey: "quiet-pages" })
    assert.ok(!("refused" in plain) && plain.delivered === "none", "progress naming no Fin stays quiet")
    await world.settle(600, 20_000, "ignore")
    assert.ok(!apexHeard("Started the review of section 2.") && !apexHeard("Half the pages are written.") && !apexHeard("Waiting on api's PR"), "and wakes no one")

    // Progress that first waits on a review, or on the person, waits on what only its Apex arranges or passes on: it
    // wakes the Apex once. loop-holds reported "ready for your review" as progress on #810 (2026-11-15), and nobody
    // heard; the same wait narrated again, or a wait on checks Mako watches, stays quiet.
    const review = [{ kind: "pull-request" as const, ref: "acme/app#810", until: "review" as const }]
    const ready = await world.agents.report(world.caller(docs), { status: "progress", summary: "Ready for review at 1a2b3c4.", waitingOn: review, clientKey: "awaits-review" })
    assert.ok(!("refused" in ready) && ready.delivered === "notice", `a first wait on a review wakes the Apex: ${JSON.stringify(ready)}`)
    await until("the Apex to hear the review it waits on", async () => apexHeard("Ready for review at 1a2b3c4."))
    const asked = world.prompts.filter((prompt) => prompt.conversation === apex.conversation).at(-1)!.text
    assert.ok(asked.includes("1 waits on someone else to act:") && asked.includes("waiting on #810 review"), asked)
    const narrated = await world.agents.report(world.caller(docs), { status: "progress", summary: "Still waiting for the review.", waitingOn: review, clientKey: "awaits-review-again" })
    assert.ok(!("refused" in narrated) && narrated.delivered === "none", "the same wait narrated again stays quiet")
    // Flipping to another wait and back, or naming the same review by its URL, is still the wait it named.
    const flipped = await world.agents.report(world.caller(docs), { status: "progress", summary: "CI first.", waitingOn: [{ kind: "pull-request", ref: "acme/app#810", until: "checks" }], clientKey: "awaits-flip" })
    assert.ok(!("refused" in flipped) && flipped.delivered === "none")
    const back = await world.agents.report(world.caller(docs), { status: "progress", summary: "Back to waiting for the review.", waitingOn: [{ kind: "pull-request", ref: "https://github.com/acme/app/pull/810", until: "review" }], clientKey: "awaits-back" })
    assert.ok(!("refused" in back) && back.delivered === "none", `a wait named since its last result stays quiet, reworded or after another: ${JSON.stringify(back)}`)
    const person = await world.agents.report(world.caller(docs), { status: "progress", summary: "Reviewed; the person merges it.", waitingOn: [...review, { kind: "person", what: "merge" }], clientKey: "awaits-person" })
    assert.ok(!("refused" in person) && person.delivered === "notice", "a first wait on the person wakes the Apex")
    const checks = await world.agents.report(world.caller(docs), { status: "progress", summary: "Pushed a fix; CI runs.", waitingOn: [{ kind: "pull-request", ref: "acme/app#811", until: "checks" }], clientKey: "awaits-checks" })
    assert.ok(!("refused" in checks) && checks.delivered === "none", "a wait on checks Mako watches stays quiet")
    await world.settle(600, 20_000, "ignore")
    assert.ok(!apexHeard("Still waiting for the review.") && !apexHeard("Pushed a fix; CI runs."), "and wakes no one")

    const reviewer = await world.agents.start(world.caller(lead), { brief: { objective: "Review the router port for API compatibility." }, harness: "cursor", name: "compat", clientKey: "compat", cwd: world.root })
    assert.ok(!("refused" in reviewer) && reviewer.conversation)
    await world.settle(600, 20_000, "ignore")
    const below = await world.agents.list(world.caller(reviewer.conversation!), { scope: "shiver" })
    assert.ok("shiver" in below && below.you === "compat" && below.shiver.length === 0, "a Fin with no others has an empty shiver")
    assert.equal(below.apex.asked, "Lead the review of the router port.", "an Apex that is a Fin too says what it was asked")

    const top = await world.agents.list(apex.caller, { scope: "shiver" })
    assert.ok("refused" in top && top.refused === "no-parent", "a Thread with no Apex has no Shiver")
  } finally {
    await world.close()
  }
}

/** The person's other Apexes: read from typed state without waking them, and messaged once, with one reply back. */
async function apexes(): Promise<void> {
  const world = new AgentsWorld({
    root: join(root, "apexes"),
    script: async (turn) => {
      if (turn.text.includes("hold")) await turn.world.hold(turn.conversation)
      if (turn.text.includes("another of the person's Threads")) return "Yes: billing-db edits src/billing/rates.ts until PR #12 merges.\n\nChange it after that."
      if (turn.text.includes("plan billing")) return `Billing is split between a schema Fin and a UI Fin.\n\n${"Details. ".repeat(80)}`
      return "ok"
    },
  })
  try {
    const app = await world.apex("codex")
    const billing = await world.apex("claude")
    const plain = await world.apex("cursor")
    const start = async (apex: { caller: AgentCaller }, name: string, harness: string, objective: string, role?: "lead") => {
      const started = await world.agents.start(apex.caller, { brief: { objective }, harness, name, clientKey: name, cwd: world.root, ...(role && { role }) })
      assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
      return started.conversation!
    }
    await start(app, "api", "claude", "Port the handlers to the new router.")
    const lead = await start(app, "review", "codex", "Lead the review of the router port.", "lead")
    await start(billing, "billing-db", "codex", "Move the rates table to integer cents.")
    await start(billing, "billing-ui", "cursor", "Show prices from cents.")
    await start({ caller: world.caller(lead) }, "compat", "cursor", "Review the port for API compatibility.")
    await world.settle()
    world.say(billing.conversation, "plan billing")
    await world.settle()
    const prompted = (conversation: string) => world.prompts.filter((prompt) => prompt.conversation === conversation).length
    const before = { app: prompted(app.conversation), billing: prompted(billing.conversation) }

    const seen = await world.agents.list(app.caller, { scope: "apexes" })
    if (!("apexes" in seen)) throw new Error(`no apexes: ${JSON.stringify(seen)}`)
    const view: AgentsApexes = seen
    assert.deepEqual(view.apexes.map((other) => other.title), ["claude apex"], "whole, only the other Apex: not itself or its own Fins")
    assert.deepEqual(view.others?.map((other) => other.title), ["cursor apex"], "and a Thread with none in a line")
    assert.equal(view.more, undefined)
    const other = view.apexes[0]!
    assert.equal(other.thread, world.store.journalPlacement(billing.conversation)!.thread)
    const handle = threadHandle(other.thread, world.root)
    assert.equal(other.handle, handle, "its handle beside its title: its folder's word and four characters of its Thread's code")
    assert.equal(other.harness, "Claude")
    assert.equal(other.working, false)
    assert.equal(other.folder, world.root)
    assert.deepEqual({ ...other.fins }, { total: 2, needs: 0, working: 0, queued: 0, idle: 0, failed: 0, done: 2 }, "its Fins by group")
    assert.deepEqual(other.digest.fins.map((fin) => fin.name).sort(), ["billing-db", "billing-ui"])
    assert.ok(other.digest.fins.every((fin) => fin.line === "done: ok"), JSON.stringify(other.digest.fins))
    assert.ok(other.digest.said?.startsWith("Billing is split between a schema Fin and a UI Fin. (+"), `its last reply's first paragraph and how much more: ${other.digest.said}`)
    assert.equal(prompted(billing.conversation), before.billing, "reading never wakes it")
    const below = await world.agents.list(world.caller(lead), { scope: "apexes" })
    assert.ok("apexes" in below && below.apexes.length === 1 && below.apexes[0]!.title === "claude apex", "a lead Fin reads the same, never its own tree")
    const alone = await world.agents.list(plain.caller, { scope: "apexes" })
    assert.ok("apexes" in alone && alone.apexes.map((each) => each.title).sort().join() === "claude apex,codex apex" && !alone.others, "a Thread with no tree reads every Apex")
    const listText = agentToolText({ ...view })
    assert.ok(!listText.includes("\n") && listText.length < 1_000, `one Apex and one Thread in ${listText.length} characters`)

    const unknown = await world.agents.send(app.caller, { to: "apex:payments", text: "Hi.", clientKey: "u" })
    assert.ok("refused" in unknown && unknown.refused === "unknown-apex" && unknown.why.includes(`apex:${handle} ("claude apex")`), JSON.stringify(unknown))
    // A handle no Thread has, and one that names a Thread that isn't another Apex: the caller's own.
    const absent = [..."2345"].map((start) => start.repeat(12)).find((code) => world.store.threadByHandle(code)?.kind === "unknown")!
    const noHandle = await world.agents.send(app.caller, { to: `apex:${absent}`, text: "Hi.", clientKey: "u2" })
    assert.ok("refused" in noHandle && noHandle.refused === "unknown-apex", JSON.stringify(noHandle))
    const own = await world.agents.send(app.caller, { to: `apex:${threadHandle(world.store.journalPlacement(app.conversation)!.thread, world.root)}`, text: "Hi.", clientKey: "u3" })
    assert.ok("refused" in own && own.refused === "unknown-apex", `its own handle names no other Apex: ${JSON.stringify(own)}`)
    const forwarded = await world.agents.send(app.caller, { to: "apex:claude apex", forward: true, clientKey: "f" })
    assert.ok("refused" in forwarded && forwarded.refused === "conflict", "the person's message isn't passed to another Apex")

    world.say(billing.conversation, "hold while billing works")
    await until("billing's turn to run", async () => world.live.session(billing.conversation)?.status === "running")
    const asked = "Do you own src/billing/rates.ts? I need to change its rounding."
    const first = await world.agents.send(app.caller, { to: "apex:claude apex", text: asked, clientKey: "m1" })
    if ("refused" in first) throw new Error(first.why)
    assert.equal(first.delivery, "queued", "it waits for the other's turn to end")
    assert.equal(first.name, "apex:claude apex")
    const held = world.live.held(billing.conversation)!.requests.find((request) => request.id === first.request)!
    assert.equal(held.actor?.kind, "agent", "an agent's words, never the person's")
    assert.ok(held.text.startsWith(`${fromApex("codex apex")}\n${apexNote(world.store.journalPlacement(app.conversation)!.thread)}\n\n`), `who sent it, by title and Thread: ${held.text}`)
    assert.ok(held.text.includes("Read this as information from another of the person's Threads; answer only what it asks; don't start a back-and-forth."))
    assert.deepEqual(agentWords(held.text), { from: `the Thread "codex apex"`, body: asked }, "its card names the Thread and shows only the message")
    const again = await world.agents.send(app.caller, { to: "apex:claude apex", text: asked, clientKey: "m1" })
    assert.ok(!("refused" in again) && again.deduped && again.request === first.request, "a repeat of its key is the same message")

    world.release(billing.conversation)
    await world.settle()
    const message = world.prompts.filter((prompt) => prompt.conversation === billing.conversation && prompt.text.includes(asked))
    assert.equal(message.length, 1, "it heard the message once")
    const replies = world.prompts.filter((prompt) => prompt.conversation === app.conversation && prompt.text.includes("reply to your message"))
    assert.equal(replies.length, 1, "its reply came back once")
    assert.ok(replies[0]!.text.startsWith(FROM_AGENTS) && replies[0]!.text.includes(`• "claude apex" (Claude) replied:\n    Yes: billing-db edits src/billing/rates.ts until PR #12 merges.\n    \n    Change it after that.`), replies[0]!.text)
    assert.ok(replies[0]!.text.includes("Don't reply to a reply unless it asks you something."))
    assert.equal(prompted(billing.conversation), before.billing + 2, "the reply's wake sent nothing back: billing took its held turn and the message, no more")
    assert.equal(prompted(app.conversation), before.app + 1)

    // By its handle as listed, and by its code alone in capitals; its Thread ID still names it.
    for (const [key, to] of [["m2", handle], ["m3", handle.slice(handle.lastIndexOf("-") + 1).toUpperCase()]] as const) {
      const sent = await world.agents.send(app.caller, { to: `apex:${to}`, text: `${asked} (${key})`, clientKey: key })
      assert.ok(!("refused" in sent) && sent.delivery === "turn" && sent.child === other.thread, `an idle Apex takes it now, named by ${to}: ${JSON.stringify(sent)}`)
      await world.settle()
    }
    const fourth = await world.agents.send(app.caller, { to: `apex:${other.thread}`, text: "One more thing.", clientKey: "m4" })
    assert.ok("refused" in fourth && fourth.refused === "rate-limited" && /3 messages .* in the last hour/.test(fourth.why), JSON.stringify(fourth))
    const repeat = await world.agents.send(app.caller, { to: "apex:claude apex", text: asked, clientKey: "m1" })
    assert.ok(!("refused" in repeat) && repeat.deduped, "a repeat past the limit still answers the first")
    const back = await world.agents.send(billing.caller, { to: "apex:codex apex", text: "PR #12 merged.", clientKey: "b1" })
    assert.ok(!("refused" in back), "the limit is the ordered pair's: the other way still goes")
    await world.settle()
  } finally {
    await world.close()
  }
}

/**
 * Messages between Apexes are kept in the store: a Fin's is refused; the reply comes back once when the host stops
 * before the other's turn, in it, after it and before the wake was queued, or after the wake was queued; the hour's
 * limit counts what earlier hosts sent; and a message leaves the store once it's answered and an hour old, or its
 * Thread is archived.
 */
async function apexesKept(): Promise<void> {
  let later = 0
  const holding = { turn: false, answer: false }
  const world = new AgentsWorld({
    root: join(root, "apexes-kept"),
    now: () => Date.now() + later,
    script: async (turn) => {
      if (holding.turn && turn.text.includes("hold")) await turn.world.hold(turn.conversation)
      if (turn.text.includes("another of the person's Threads")) {
        if (holding.answer) await turn.world.hold(turn.conversation)
        return "It's billing's until PR #12 merges."
      }
      return "ok"
    },
  })
  try {
    const app = await world.apex("codex")
    const billing = await world.apex("claude")
    const start = async (apex: { caller: AgentCaller }, name: string, role?: "lead") => {
      const started = await world.agents.start(apex.caller, { brief: { objective: `Do ${name}.` }, harness: "codex", name, clientKey: name, cwd: world.root, ...(role && { role }) })
      assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
      return started.conversation!
    }
    const worker = await start(app, "api")
    const lead = await start(app, "review", "lead")
    await start({ caller: world.caller(lead) }, "compat")
    await start(billing, "billing-db")
    await world.settle()
    const threadOf = (conversation: string) => world.store.journalPlacement(conversation)!
    const pair = [threadOf(app.conversation).thread, threadOf(billing.conversation).thread] as const
    const heard = (conversation: string, words: string) => world.prompts.filter((prompt) => prompt.conversation === conversation && prompt.text.includes(words)).length
    const replies = () => heard(app.conversation, "reply to your message")
    const opened = () => world.live.snapshot(billing.conversation)!
    /** A message as the store keeps one this Apex sent that one, for a point a host stopped at that no restart here reaches. */
    const keep = (at = Date.now()) => world.store.keepApexMessage({ request: randomUUID(), sender: threadOf(app.conversation), thread: pair[1], conversation: billing.conversation, label: `"claude apex" (Claude)`, fin: { name: "claude apex", harness: "claude" }, at }).message.request

    for (const fin of [worker, lead]) {
      const refused = await world.agents.send(world.caller(fin), { to: "apex:claude apex", text: "Do you own src/billing/rates.ts?", clientKey: "fin" })
      assert.ok("refused" in refused && refused.refused === "access" && refused.why.includes("agents_report") && refused.why.includes("Nothing was sent"), `a Fin, a lead too, asks through its Apex: ${JSON.stringify(refused)}`)
    }
    await world.settle()
    assert.equal(heard(billing.conversation, "another of the person's Threads"), 0, "and nothing reached the other Apex")
    assert.deepEqual(world.store.apexSends(...pair, 0), [], "nor counted for anyone")

    // The host is killed while the message waits behind the other's turn.
    holding.turn = true
    world.say(billing.conversation, "hold while billing works")
    await until("billing's turn to run", async () => world.live.session(billing.conversation)?.status === "running")
    const first = await world.agents.send(app.caller, { to: "apex:claude apex", text: "Whose is rates.ts? (one)", clientKey: "k1" })
    assert.ok(!("refused" in first) && first.delivery === "queued", JSON.stringify(first))
    holding.turn = false
    await world.crashed()
    await world.settle()
    assert.equal(heard(billing.conversation, "(one)"), 1, "the next host's turn hears it once")
    assert.equal(replies(), 1, "and its reply wakes the sender, whose host never sent it")
    assert.deepEqual(world.store.owedApexMessages(), [], "answered, it's owed nothing more")
    await world.restart()
    await world.settle()
    assert.equal(replies(), 1, "nor does a later host send it again")

    // The host stops in the turn that answers it: the turn that continues it replies.
    holding.answer = true
    opened()
    const second = await world.agents.send(app.caller, { to: "apex:claude apex", text: "Whose is rates.ts? (two)", clientKey: "k2" })
    assert.ok(!("refused" in second) && second.delivery === "turn", JSON.stringify(second))
    await until("billing's turn on it to run", async () => world.live.session(billing.conversation)?.status === "running")
    holding.answer = false
    await world.restart()
    await world.settle()
    assert.equal(replies(), 2, "a turn the host's stop cut replies as it's continued, once")
    assert.equal(heard(app.conversation, `"claude apex" (Claude) failed:`), 0, "and the cut itself was no reply")
    assert.deepEqual(world.store.owedApexMessages(), [])
    // Nor is it one when the cut turn's end is heard as the host goes: a message that rode that turn stays owed.
    const cut = opened().requests.find((request) => request.id === second.request)!
    assert.equal(cut.interruption?.reason, "host-quit")
    const riding = keep()
    world.store.steerApexMessage(riding, cut.id)
    world.agents.settled(billing.conversation, cut.id)
    assert.deepEqual(world.store.owedApexMessages().map((owed) => [owed.request, owed.reply]), [[riding, undefined]])
    world.store.dropApexMessage(riding)

    // The host stops with the reply kept and its wake not yet queued.
    const kept = keep()
    world.store.keepApexReply(kept, { status: "done", summary: "Kept before the host stopped.", from: threadOf(billing.conversation).session, at: Date.now() })
    await world.restart()
    await world.settle()
    assert.equal(heard(app.conversation, "Kept before the host stopped."), 1, "the next host sends the kept reply")
    assert.deepEqual(world.store.owedApexMessages(), [])
    // And with its wake queued, before the message was settled: the digest in the sender's queue is its receipt.
    await world.close()
    const db = new DatabaseSync(join(world.root, "threads.sqlite"))
    db.prepare("UPDATE apex_messages SET heard_at = NULL WHERE request = ?").run(kept)
    db.close()
    world.open()
    await world.resumed
    await world.settle()
    assert.equal(heard(app.conversation, "Kept before the host stopped."), 1, "a reply its sender's queue carries isn't sent again")
    assert.equal(replies(), 3)
    assert.deepEqual(world.store.owedApexMessages(), [], "and its message is settled")

    // Three went from this Apex to that one this hour, under three hosts.
    assert.equal(world.store.apexSends(...pair, 0).length, 3)
    opened()
    const fourth = await world.agents.send(app.caller, { to: "apex:claude apex", text: "One more thing.", clientKey: "k4" })
    assert.ok("refused" in fourth && fourth.refused === "rate-limited", `the limit counts what earlier hosts sent: ${JSON.stringify(fourth)}`)
    later = 3_600_001
    const next = await world.agents.send(app.caller, { to: "apex:claude apex", text: "Whose is rates.ts? (five)", clientKey: "k5" })
    assert.ok(!("refused" in next), `an hour on, the next goes: ${JSON.stringify(next)}`)
    assert.equal(world.store.apexSends(...pair, 0).length, 1, "and the answered ones an hour old are gone")
    await world.settle()
    assert.equal(replies(), 4)
    assert.deepEqual(world.store.owedApexMessages(), [])

    // One still owed a reply is kept past the hour, and goes with its Thread.
    keep(Date.now() - 2 * 3_600_000)
    world.store.pruneApexMessages(Date.now() - 3_600_000, Date.now() - 7 * 24 * 3_600_000)
    assert.equal(world.store.owedApexMessages().length, 1, "a reply still owed outlasts the hour")
    world.archived.add(billing.conversation)
    await world.agents.archived(billing.conversation)
    assert.deepEqual(world.store.apexSends(...pair, 0), [], "an archived Thread's messages are dropped, either way")
    assert.deepEqual(world.store.owedApexMessages(), [])
  } finally {
    await world.close()
  }
}

/**
 * Any top-level Thread of the person's here, not only one that leads Fins: addressed by its handle, title or Thread
 * ID; one this host hasn't read in is read in on send; `scope: apexes` lists the few the person wrote in last; its
 * reply wakes the sender once across a restart; a turn of its that answers and is cut goes on with the person's own
 * left for Continue; and a Fin is still refused, as a sender and as a target.
 */
async function plainThreads(): Promise<void> {
  const holding = { answer: false }
  // Three messages an hour go from one Thread to another: each part below starts an hour on.
  let later = 0
  const hourOn = () => { later += 3_600_001 }
  const world = new AgentsWorld({
    root: join(root, "plain"),
    now: () => Date.now() + later,
    script: async (turn) => {
      if (turn.text.includes("hold")) await turn.world.hold(turn.conversation)
      if (turn.text.includes("another of the person's Threads")) {
        if (holding.answer) await turn.world.hold(turn.conversation)
        return `Answered: ${/\(([a-z]+)\)\s*$/.exec(turn.text)?.[1] ?? "?"}.`
      }
      return "ok"
    },
  })
  try {
    const app = await world.apex("codex")
    const started = await world.agents.start(app.caller, { brief: { objective: "Port the handlers." }, harness: "claude", name: "api", clientKey: "api", cwd: world.root })
    assert.ok(!("refused" in started) && started.conversation, JSON.stringify(started))
    const notes = await world.apex("claude", "auto", undefined, "Release notes for 4.2")
    const extra = []
    for (const at of [1, 2, 3, 4, 5, 6, 7]) extra.push(await world.apex("cursor", "auto", undefined, `Side thread ${at}`))
    await world.settle()
    const thread = (conversation: string) => world.store.journalPlacement(conversation)!.thread
    const replies = () => world.prompts.filter((prompt) => prompt.conversation === app.conversation && prompt.text.includes("reply to your message")).length
    const heard = (words: string) => world.prompts.filter((prompt) => prompt.conversation === notes.conversation && prompt.text.includes(words)).length
    const handle = threadHandle(thread(notes.conversation), world.root)

    // Listed: the person's Threads that worked last, a line each, and a count of the rest.
    for (const conversation of [...extra.slice(4), notes].map((each) => each.conversation)) world.say(conversation, "Note this.")
    await world.settle()
    const seen = await world.agents.list(app.caller, { scope: "apexes" })
    if (!("apexes" in seen)) throw new Error(JSON.stringify(seen))
    assert.deepEqual(seen.apexes, [], "no other Thread leads a Fin")
    assert.equal(seen.others?.length, 5, "five Threads in a line each")
    assert.equal(seen.more, 3, "the other three counted")
    assert.ok(seen.others.slice(0, 4).every((each) => ["Release notes for 4.2", "Side thread 5", "Side thread 6", "Side thread 7"].includes(each.title ?? "")), `those the person wrote in last first: ${JSON.stringify(seen.others)}`)
    const listed = seen.others.find((each) => each.title === "Release notes for 4.2")!
    assert.deepEqual(listed, { handle, title: "Release notes for 4.2", harness: "Claude", working: false, folder: world.root }, "its handle, title, harness, folder, and whether it works")
    const text = agentToolText({ ...seen })
    assert.ok(text.length < 1_000, `${text.length} characters for five Threads, each with this test's long folder, and the count of the rest`)
    console.log(`test:orch-comms: scope apexes with five plain Threads listed and three counted is ${text.length} characters`)

    // By its handle, its title and its Thread ID; an idle one takes it now, as an Apex does.
    for (const [key, to] of [["h", handle], ["t", "release notes for 4.2"], ["i", thread(notes.conversation)]] as const) {
      const sent = await world.agents.send(app.caller, { to: `apex:${to}`, text: `Is the changelog frozen? (${key === "h" ? "handle" : key === "t" ? "title" : "id"})`, clientKey: `plain-${key}` })
      assert.ok(!("refused" in sent) && sent.child === thread(notes.conversation) && sent.delivery === "turn", `named by ${to}: ${JSON.stringify(sent)}`)
      await world.settle()
    }
    assert.equal(replies(), 3, "each answered once")
    const card = world.live.snapshot(notes.conversation)!.requests.find((request) => request.text.includes("(handle)"))!
    assert.deepEqual(agentWords(card.text), { from: `the Thread "codex apex"`, body: "Is the changelog frozen? (handle)" }, "its transcript draws it as a card from the Thread that sent it, as an Apex's does")
    assert.equal(card.actor?.kind, "agent")

    // A Fin is refused as a target too, pointed at its Apex; and as a sender.
    const fin = await world.agents.send(app.caller, { to: `apex:${threadHandle(thread(started.conversation!), world.root)}`, text: "Hi.", clientKey: "to-fin" })
    assert.ok("refused" in fin && fin.refused === "unknown-apex" && fin.why.includes(`is a Fin of ${thread(app.conversation)}`), JSON.stringify(fin))
    const from = await world.agents.send(world.caller(started.conversation!), { to: `apex:${handle}`, text: "Hi.", clientKey: "from-fin" })
    assert.ok("refused" in from && from.refused === "access", JSON.stringify(from))

    // A host that starts reads in nothing it has nothing for: the target isn't in memory, and is read in on send.
    await world.restart()
    await world.settle()
    assert.equal(world.live.loaded(notes.conversation), false, "not in memory after a restart")
    const other = await world.apex("grok", "auto", undefined, "Another sender")
    const cold = await world.agents.send(other.caller, { to: `apex:${handle}`, text: "Ship it? (cold)", clientKey: "cold" })
    assert.ok(!("refused" in cold) && cold.delivery === "turn", `read in on send: ${JSON.stringify(cold)}`)
    await world.settle()
    assert.equal(heard("(cold)"), 1)
    assert.equal(world.prompts.filter((prompt) => prompt.conversation === other.conversation && prompt.text.includes("Answered: cold.")).length, 1, "and its reply woke the sender")
    // Its key repeated by a later host, the target out of memory again: read in, its message is found there, and sent once.
    await world.restart()
    await world.settle()
    assert.equal(world.live.loaded(notes.conversation), false)
    const repeat = await world.agents.send(other.caller, { to: `apex:${handle}`, text: "Ship it? (cold)", clientKey: "cold" })
    assert.ok(!("refused" in repeat) && repeat.deduped && repeat.request === cold.request, `a repeat of its key is the same message: ${JSON.stringify(repeat)}`)
    await world.settle()
    assert.equal(heard("(cold)"), 1, "heard once")

    // A restart between send and reply: the next host's turn answers, and wakes the sender once.
    hourOn()
    world.say(notes.conversation, "hold while it writes")
    await until("the notes' turn to run", async () => world.live.session(notes.conversation)?.status === "running")
    const queued = await world.agents.send(app.caller, { to: `apex:${handle}`, text: "Who signs off? (queued)", clientKey: "queued" })
    assert.ok(!("refused" in queued) && queued.delivery === "queued", JSON.stringify(queued))
    await world.crashed()
    await world.settle()
    assert.equal(heard("(queued)"), 1, "heard once by the next host")
    assert.equal(replies(), 4, "its reply woke the sender once")
    await world.restart()
    await world.settle()
    assert.equal(replies(), 4, "and no later host sends it again")
    assert.deepEqual(world.store.owedApexMessages(), [])

    // Cut by Mako's exit, with the person's own turns left for Continue: the turn that answers goes on, and replies once.
    world.live.setConversationSettings({ continueAfterRestart: false })
    hourOn()
    holding.answer = true
    const cut = await world.agents.send(app.caller, { to: `apex:${handle}`, text: "Freeze it? (cut)", clientKey: "cut" })
    if ("refused" in cut) throw new Error(cut.why)
    await until("the answering turn to run", async () => world.live.session(notes.conversation)?.status === "running")
    holding.answer = false
    await world.restart()
    await world.settle()
    const requests = world.live.snapshot(notes.conversation)!.requests
    assert.equal(requests.find((request) => request.id === cut.request)?.interruption?.reason, "host-quit", "the exit cut the turn that answers")
    assert.ok(requests.some((request) => request.continues?.requestId === cut.request && request.status === "completed"), `and Mako continued it: ${JSON.stringify(requests.slice(-2).map((request) => [request.status, request.continues]))}`)
    assert.equal(replies(), 5, "whose end replied once")
    assert.deepEqual(world.store.owedApexMessages(), [])
    // The person's own cut turn still waits for Continue, as they chose.
    world.say(notes.conversation, "hold for the person")
    await until("the person's turn to run", async () => world.live.session(notes.conversation)?.status === "running")
    const before = world.prompts.filter((prompt) => prompt.conversation === notes.conversation).length
    await world.restart()
    await world.settle()
    assert.equal(world.prompts.filter((prompt) => prompt.conversation === notes.conversation).length, before, "the person's own cut turn waits for Continue")
  } finally {
    await world.close()
  }
}

function doors(): void {
  const list = AGENT_TOOLS.find((tool) => tool.verb === "list")!
  assert.deepEqual(agentToolSchema(list).parse({ scope: "shiver" }), { scope: "shiver" }, "the MCP door takes scope shiver")
  assert.deepEqual(agentToolSchema(list).parse({ scope: "apexes" }), { scope: "apexes" }, "and scope apexes")
  assert.deepEqual(agentToolSchema(list).parse({ scope: LEGACY_SHIVER_SCOPE }), { scope: LEGACY_SHIVER_SCOPE }, "and scope crew, from agents of older builds")
  assert.throws(() => agentToolSchema(list).parse({ scope: "everyone" }), "but no other word")
  const advertised = JSON.stringify(z.toJSONSchema(agentToolSchema(list), { io: "input" }))
  assert.ok(advertised.includes('"shiver"') && !advertised.includes(`"${LEGACY_SHIVER_SCOPE}"`), `the schema advertises shiver alone: ${advertised}`)
  assert.match(list.mcp.fields.scope!, /shiver/)
  assert.match(ORCHESTRATION_INSTRUCTIONS, /scope: apexes.*reading never wakes them/)
}

function replyDigest(): void {
  const reply: Notice = { id: "notice:reply", report: report("Yes, it's mine until PR #12 merges."), label: `"billing" (Claude)`, fin: { name: "billing", harness: "claude" }, from: "s", reply: true }
  const text = digest([reply, notice("Opened the PR.")], "0 working, 1 ended.")
  assert.match(text, /Another Thread's reply to your message:\n {2}• "billing" \(Claude\) replied:\n {4}Yes, it's mine until PR #12 merges\.\n {2}Don't reply to a reply unless it asks you something\.\n1 finished:\n/, text)
  assert.ok(!digest([reply], "0 working.").includes("finished:"), "a reply isn't a Fin's report")
  assert.ok(readFinReports(digest([reply], "0 working.")).text.endsWith("Go on with it: reply to the person, start more work, or end your turn."))
}

/** Every entry the digest writes has its structured twin after it, from the same record, in its order: the person's card reads that, never the words. */
function digestTwins(): void {
  const result: Notice = { ...notice("The migration ran on a copy. 3 rows were fixed.", { id: "report:result" }), id: "notice:result", settledOnly: true }
  const reply: Notice = { id: "notice:reply", report: report("Yes, it's mine.", { id: "report:reply" }), label: `"billing" (Claude)`, fin: { name: "billing", harness: "claude" }, from: "s", reply: true }
  const decision: Notice = { ...notice("Open the PR?", { id: "report:decision", status: "needs-input", question: "Open the PR for composer A as shown?", options: [{ label: "Open the PR" }, { label: "Change something first" }], recommended: 0 }), id: "notice:decision", label: `"ux-v2" (Cursor)`, fin: { name: "ux-v2", harness: "cursor" } }
  const person: Notice = { ...notice("Which tone?", { id: "report:person", status: "blocked", question: "Plain or friendly?", for: "person" }), id: "notice:person" }
  const done: Notice = { ...notice("## Summary\n\nOpened #369.\n\nMore detail.", { id: "report:done", artifacts: [{ kind: "pull-request", ref: "https://github.com/Verbiflow/mako/pull/369" }] }), id: "notice:done" }
  const failed: Notice = { ...notice("The gateway refused the test account.", { id: "report:failed", status: "failed" }), id: "notice:failed" }
  const text = digest([done, person, failed, decision, reply, result], "7 working, 1 queued, 25 ended.")
  const { text: words, reports } = readFinReports(text)
  assert.ok(text.startsWith(words) && text.length > words.length, "the words first, unchanged, the data after them")
  assert.ok(words.endsWith("Reply to the person, start more work, or end your turn."), "the digest's own last line ends the words")
  const entries = words.split("\n").filter((line) => line.startsWith("  • "))
  assert.equal(reports.length, entries.length, `one twin per entry: ${entries.length} entries, ${reports.length} twins`)
  assert.deepEqual(reports.map((card) => card.report), ["report:result", "report:reply", "report:decision", "report:person", "report:done", "report:failed"], "in the digest's order")
  entries.forEach((entry, index) => assert.ok(entry.includes(`"${reports[index]!.name}"`), `entry ${index} and its twin name the same one: ${entry}`))
  const [, apex, asks, theirs, finished] = reports
  assert.equal(apex!.apex, true, "a reply is another Apex's")
  assert.deepEqual([asks!.status, asks!.harness, asks!.line, asks!.options?.map((option) => option.label), asks!.recommended], ["needs-input", "cursor", "Open the PR for composer A as shown?", ["Open the PR", "Change something first"], 0])
  assert.equal(theirs!.forPerson, true, "an ask left to the person says so")
  assert.equal(finished!.line, "Opened #369.", "a finished one's line is its first paragraph past the heading")
  assert.equal(finished!.artifacts?.[0]?.ref, "https://github.com/Verbiflow/mako/pull/369")
  for (const card of reports) assert.doesNotMatch(JSON.stringify(card), /agents_(answer|read)|end your turn|person: true/, "no words for the Apex in a card")
  assert.equal(readFinReports(`${words}\n\n<mako-reports>\n{"version":2,"reports":[]}\n</mako-reports>`).reports.length, 0, "a block it can't read stays words")
}

/**
 * A burst past what one wake's cards hold: a digest of more never throws and keeps what its block can carry, and the
 * Apex's wakes take them `FIN_REPORTS_MAX` at a time, every report heard and none lost.
 */
async function manyReports(): Promise<void> {
  const many = Array.from({ length: FIN_REPORTS_MAX + 6 }, (_, index): Notice => ({
    ...notice(`Fin ${index} finished.`, { id: `report:many:${index}` }),
    id: `notice:many:${index}`,
    label: `"fin-${index}" (Codex)`,
    fin: { name: `fin-${index}`, harness: "codex" },
    from: "00000000-0000-4000-8000-000000000001",
  }))
  const read = readFinReports(digest(many, "70 ended."))
  assert.equal(read.reports.length, FIN_REPORTS_MAX, "a digest of more than a block holds carries as many cards as it can")
  assert.ok(many.every((_, index) => read.text.includes(`"fin-${index}" (Codex)`)), "and its words say every one")

  const long: Notice = { ...many[0]!, id: "notice:long", fin: { name: "x".repeat(500), harness: "codex" }, label: `"${"x".repeat(500)}" (Codex)` }
  const kept = readFinReports(digest([long, many[1]!], "2 ended."))
  assert.deepEqual(kept.reports.map((card) => card.name), ["fin-1"], "a card its schema refuses is left to the words, the rest kept")

  // The Apex's queue, as the producer sees it: each digest an entry, the newest unsent one open to join.
  const entries: { id: string; text: string; notices: Notice[]; sent?: true }[] = []
  const wakesOf = new AgentWakes({
    ready: () => "idle",
    unsent: () => entries.flatMap((entry) => (entry.sent ? [] : [{ id: entry.id, notices: entry.notices }])),
    carried: (_conversation, notice) => entries.some((entry) => entry.notices.some((each) => each.id === notice)),
    admit: (_conversation, id, text, notices) => void entries.push({ id, text, notices: [...notices] }),
    rewrite: (_conversation, id, text, notices) => {
      const entry = entries.find((candidate) => candidate.id === id && !candidate.sent)
      if (!entry) return false
      entry.text = text
      entry.notices = [...notices]
      return true
    },
    steer: () => false,
    assign: () => {},
    delivered: () => {},
    counts: () => "70 ended.",
  })
  try {
    for (const each of many) wakesOf.notice("apex", "apex", each)
    assert.equal(entries.length, 2, "a burst of more than a digest holds is two digests in the Apex's queue")
    assert.equal(readFinReports(entries[0]!.text).reports.length, FIN_REPORTS_MAX, "the first of as many as it holds")
    assert.equal(readFinReports(entries[1]!.text).reports.length, many.length - FIN_REPORTS_MAX, "the rest in the next, which goes after it")
    assert.equal(wakesOf.pending(), 2, "the two unsent digests are what waits, in the queue")
  } finally {
    wakesOf.dispose()
  }
}

try {
  compactAnswers()
  finishedLines()
  replyDigest()
  doors()
  digestTwins()
  await manyReports()
  await shiver()
  await apexes()
  await apexesKept()
  await plainThreads()
  console.log("test:orch-comms: compact answers, finished lines, every digest entry's structured twin, bursts past one wake's cards, the Shiver view and its brief line, other Apexes read and messaged, their messages kept across hosts, and plain top-level Threads listed, messaged and continued pass")
} finally {
  rmSync(root, { recursive: true, force: true })
}
