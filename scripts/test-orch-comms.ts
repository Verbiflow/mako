import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AGENT_TOOLS, type AgentsCrew } from "@mako/host/contracts/agent-tools"
import type { Report } from "@mako/host/contracts/agents"
import { agentWords, fromAgent, YOUR_APEX } from "@mako/host/contracts/children"
import { ThreadIdSchema } from "@mako/host/contracts/thread-identity"
import { agentToolSchema, agentToolText } from "@mako/host/conversations/agent-tools"
import { digest, finishedLine, type Notice } from "@mako/host/conversations/agent-wakes"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * What an Apex and its Fins tell each other, and what each costs
 * (`npm run test:orch-comms`): every tool's answer is its JSON on one line,
 * every field kept; a finished Fin's digest line carries its first paragraph
 * and every artifact's ref, and says how much more `agents_read` gives; and
 * a Fin reads its Apex and the other Fins it started (`agents_list` with
 * `scope: crew`), from typed state, as its brief tells it it can.
 */
const root = mkdtempSync(join(tmpdir(), "mako-orch-comms-"))
const CHILD = ThreadIdSchema.parse("6b0c3c2e-5f8a-4d39-9a43-1d1b4c0f2a11")

function report(summary: string, extra: Partial<Report> = {}): Report {
  return { id: `report:${CHILD}:${summary.length}`, child: CHILD, status: "done", summary, ownerGeneration: 1, at: 1, ...extra }
}
const notice = (summary: string, extra: Partial<Report> = {}): Notice => ({ id: `notice:${summary.length}`, report: report(summary, extra), label: `"docs" (Codex)`, from: "s" })

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
  assert.equal(finishedLine(report(long)), `The parser now reads quoted fields. (+${(long.length - "The parser now reads quoted fields.".length).toLocaleString("en-US")} chars: agents_read)`, "its first paragraph past the heading, on one line, and how much more there is")
  const wall = "word ".repeat(400).trim()
  const line = finishedLine(report(wall))
  assert.ok(line.startsWith("word word") && line.includes("…") && line.endsWith("chars: agents_read)") && line.length < 560, "a paragraph past the line's room is cut")
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

function doors(): void {
  const list = AGENT_TOOLS.find((tool) => tool.verb === "list")!
  assert.deepEqual(agentToolSchema(list).parse({ scope: "crew" }), { scope: "crew" }, "the MCP door takes scope crew")
  assert.match(list.mcp.fields.scope!, /crew/)
}

try {
  compactAnswers()
  finishedLines()
  doors()
  await crew()
  console.log("test:orch-comms: compact answers, finished lines, the crew view and its brief line pass")
} finally {
  rmSync(root, { recursive: true, force: true })
}
