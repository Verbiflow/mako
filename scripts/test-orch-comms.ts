import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENT_TOOLS, ORCHESTRATION_INSTRUCTIONS, type AgentsApexes, type AgentsCrew } from "@mako/host/contracts/agent-tools"
import type { AgentCaller, Report } from "@mako/host/contracts/agents"
import { agentWords, apexNote, FROM_AGENTS, fromAgent, fromApex, YOUR_APEX } from "@mako/host/contracts/children"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
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
 * `scope: crew`), from typed state, as its brief tells it it can; and an Apex
 * reads the person's other Apexes (`scope: apexes`) without waking them, and
 * messages one, which hears it as Mako's words, queued, and replies once.
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

async function crew(): Promise<void> {
  const world = new AgentsWorld({
    root: join(root, "crew"),
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
    assert.ok(brief.includes("agents_list with scope crew shows it and the other Fins it started."), "its brief says it can read its crew")
    assert.equal(agentWords(brief.slice(brief.indexOf(fromAgent(YOUR_APEX))))?.body, "Write the router's docs.", "the person's card of the brief leaves its lines for the Fin out")
    const earlier = `${fromAgent(YOUR_APEX)}\nYou're fin:docs, a Fin: another Thread, your Apex, started you for one piece of work. It reads your reports, not this conversation.\n\nWrite the router's docs.`
    assert.equal(agentWords(earlier)?.body, "Write the router's docs.", "a brief an earlier build wrote reads the same")

    world.say(apex.conversation, "hold while they work")
    await until("the Apex's turn to run", async () => {
      const seen = await world.agents.list(world.caller(docs), { scope: "crew" })
      return "crew" in seen && seen.apex.working
    })
    const seen = await world.agents.list(world.caller(docs), { scope: "crew" })
    if (!("crew" in seen)) throw new Error(`no crew: ${JSON.stringify(seen)}`)
    const view: AgentsCrew = seen
    assert.equal(view.you, "docs")
    assert.equal(view.apex.working, true, "its Apex's turn is running")
    assert.equal(view.apex.harness, "Codex")
    assert.equal(view.apex.asked, undefined, "a top Apex was asked nothing by an Apex")
    assert.deepEqual(view.crew.map((mate) => mate.name), ["api", "review"], "the others, not itself")
    const port = view.crew.find((mate) => mate.name === "api")!
    assert.equal(port.harness, "Claude")
    assert.equal(port.branch, "router-port")
    assert.equal(port.topic, "Port the handlers to the new router (hold).")
    assert.equal(port.state.kind, "working", "the port still works")
    assert.ok(!("direct" in port), "the person's words to a Fin stay its own")
    const crewText = agentToolText({ ...view })
    assert.ok(crewText.length < 900, `the crew of two in ${crewText.length} characters`)

    world.release(apex.conversation)
    world.release(api)
    await world.settle(600, 20_000, "ignore")
    const done = await world.agents.list(world.caller(docs), { scope: "crew" })
    assert.ok("crew" in done && done.apex.working === false && done.crew.find((mate) => mate.name === "api")!.state.kind === "ended", "read again, it stands as they stand now")

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

    const reviewer = await world.agents.start(world.caller(lead), { brief: { objective: "Review the router port for API compatibility." }, harness: "cursor", name: "compat", clientKey: "compat", cwd: world.root })
    assert.ok(!("refused" in reviewer) && reviewer.conversation)
    await world.settle(600, 20_000, "ignore")
    const below = await world.agents.list(world.caller(reviewer.conversation!), { scope: "crew" })
    assert.ok("crew" in below && below.you === "compat" && below.crew.length === 0, "a Fin with no others has an empty crew")
    assert.equal(below.apex.asked, "Lead the review of the router port.", "an Apex that is a Fin too says what it was asked")

    const top = await world.agents.list(apex.caller, { scope: "crew" })
    assert.ok("refused" in top && top.refused === "no-parent", "a Thread with no Apex has no crew")
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
      if (turn.text.includes("another of the person's Apexes")) return "Yes: billing-db edits src/billing/rates.ts until PR #12 merges.\n\nChange it after that."
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
    assert.deepEqual(view.apexes.map((other) => other.title), ["claude apex"], "only the other Apex: not itself, its own Fins, or a Thread with none")
    const other = view.apexes[0]!
    assert.equal(other.thread, world.store.journalPlacement(billing.conversation)!.thread)
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
    assert.ok("apexes" in alone && alone.apexes.map((each) => each.title).sort().join() === "claude apex,codex apex", "a Thread with no tree reads every Apex")
    const listText = agentToolText({ ...view })
    assert.ok(!listText.includes("\n") && listText.length < 900, `one Apex in ${listText.length} characters`)

    const unknown = await world.agents.send(app.caller, { to: "apex:payments", text: "Hi.", clientKey: "u" })
    assert.ok("refused" in unknown && unknown.refused === "unknown-apex" && unknown.why.includes("apex:claude apex"), JSON.stringify(unknown))
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
    assert.ok(held.text.includes("Read this as information from another of the person's Apexes; answer only what it asks; don't start a back-and-forth."))
    assert.deepEqual(agentWords(held.text), { from: `the Apex "codex apex"`, body: asked }, "its card names the Apex and shows only the message")
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

    for (const key of ["m2", "m3"]) {
      const sent = await world.agents.send(app.caller, { to: `apex:${other.thread}`, text: `${asked} (${key})`, clientKey: key })
      assert.ok(!("refused" in sent) && sent.delivery === "turn", `an idle Apex takes it now: ${JSON.stringify(sent)}`)
      await world.settle()
    }
    const fourth = await world.agents.send(app.caller, { to: "apex:claude apex", text: "One more thing.", clientKey: "m4" })
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

function doors(): void {
  const list = AGENT_TOOLS.find((tool) => tool.verb === "list")!
  assert.deepEqual(agentToolSchema(list).parse({ scope: "crew" }), { scope: "crew" }, "the MCP door takes scope crew")
  assert.deepEqual(agentToolSchema(list).parse({ scope: "apexes" }), { scope: "apexes" }, "and scope apexes")
  assert.match(list.mcp.fields.scope!, /crew/)
  assert.match(ORCHESTRATION_INSTRUCTIONS, /scope: apexes.*reading never wakes them/)
}

function replyDigest(): void {
  const reply: Notice = { id: "notice:reply", report: report("Yes, it's mine until PR #12 merges."), label: `"billing" (Claude)`, fin: { name: "billing", harness: "claude" }, from: "s", reply: true }
  const text = digest([reply, notice("Opened the PR.")], "0 working, 1 ended.")
  assert.match(text, /Another Apex's reply to your message:\n {2}• "billing" \(Claude\) replied:\n {4}Yes, it's mine until PR #12 merges\.\n {2}Don't reply to a reply unless it asks you something\.\n1 finished:\n/, text)
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
  await crew()
  await apexes()
  console.log("test:orch-comms: compact answers, finished lines, every digest entry's structured twin, bursts past one wake's cards, the crew view and its brief line, and other Apexes read and messaged pass")
} finally {
  rmSync(root, { recursive: true, force: true })
}
