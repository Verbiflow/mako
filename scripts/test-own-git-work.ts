import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACCESS_TIER_NAMES, type AccessTier } from "@mako/host/contracts/access"
import { AGENT_TOOL_ROLES } from "@mako/host/contracts/agent-tools"
import { POLICY, primerText } from "@mako/host/contracts/primer"
import type { MoveOutcome } from "@mako/host/contracts/workspace-moves"
import { WorkspaceMoves } from "@mako/host/workspaces/moves"
import { broughtSentence, outcomeSentences, returnedSentence } from "@mako/host/workspaces/worktree-move"
import { makoToolList } from "./lib/mako-tool-list.ts"

/*
 * An agent does its own Git work with Mako's tools and isn't sent to the person for it.
 *
 * - Which of Mako's own asks an agent's Git work meets under each access tier: a move onto its own branch asks below
 *   full access (unless the project always allows it) and goes at once on it; opening, pushing and re-running the
 *   checks of its own pull request are its work at every tier; merging stays the person's call below full access.
 * - No agent-facing text (the mako server's instructions and tools at every role and tier, the primer, what a move
 *   tells the agent) tells it to leave to the person what a tool does, as the words that sent an agent to the Changes
 *   panel for its own held changes did.
 */

const share = (paths: string[]) => ({ files: paths.length, lines: paths.length * 3, paths })
const none = share([])
const outcome: MoveOutcome = {
  came: share(["a.ts", "b.ts"]),
  likely: share(["b.ts"]),
  stayed: { others: share(["c.ts"]), person: share(["d.ts"]), uncertain: share(["e.ts"]), unattributed: share(["f.ts"]) },
  split: [],
  brought: false,
  unstaged: [],
}

// 1. A move onto the Thread's own branch, under each tier.
const root = mkdtempSync(join(tmpdir(), "mako-own-git-"))
try {
  const tiers = new Map<string, AccessTier | undefined>()
  const project = join(root, "project")
  const moves = (file = join(root, "moves.json")) => new WorkspaceMoves({
    file,
    source: (id) => ({ cwd: project, harness: "claude", busy: true, ...id.startsWith("t-") && { title: id } }),
    companions: () => [],
    place: async () => ({ project, changed: 1, shares: { thread: share(["a.ts"]), others: none, person: none, uncertain: share(["e.ts"]), unattributed: none, split: [] } }),
    move: async (id) => id,
    follow: async () => {},
    announce: () => {},
    failed: () => {},
    fullAccess: (id) => tiers.get(id) === "full",
  })
  const each = moves()
  for (const tier of [...ACCESS_TIER_NAMES, undefined]) {
    const id = `t-${tier ?? "none"}`
    tiers.set(id, tier)
    const said = await each.ask(id)
    if (tier === "full") {
      assert.equal(each.answerFor(id), "allowed", "full access is the person's grant: the move goes without a card")
      assert.match(said, /^Allowed: this Thread is on full access\./)
    } else {
      assert.equal(each.answerFor(id), "asking", `${tier ?? "a harness without tiers"} asks the person in the composer`)
      assert.match(said, /^Asked the user\./)
    }
    assert.match(said, /worktree_bring stayed: true brings them/, "what stays says how the agent brings it, not that the person must")
  }
  // Allowed once by the person, the reason is theirs, not full access's.
  const once = moves(join(root, "once.json"))
  tiers.set("t-ask-once", "ask")
  await once.ask("t-ask-once")
  once.answer(once.state().requests[0]!.id, "allow")
  assert.match(await once.ask("t-ask-once"), /^Allowed: the user allowed it\./)
  // A project that always allows it still does, at any tier.
  const always = moves(join(root, "always.json"))
  await always.ask("t-ask")
  always.answer(always.state().requests[0]!.id, "always")
  const later = moves(join(root, "always.json"))
  assert.match(await later.ask("t-edits"), /^Allowed: this project lets agents move without asking\./)
} finally {
  rmSync(root, { recursive: true, force: true })
}

// 2. The pull request tools as each tier lists them: the branch's own work at every tier, merging the person's below full.
const listed = { below: await makoToolList("thread"), full: await makoToolList("thread", { fullAccess: true }) }
const describe = (which: keyof typeof listed, name: string) => {
  const tool = listed[which].tools.find((each) => each.name === name)
  assert.ok(tool, `${name} is listed`)
  return tool.description ?? ""
}
for (const name of ["pull_request_open", "pull_request_rerun"]) {
  assert.equal(describe("below", name), describe("full", name), `${name} is the Thread's own work whatever its access`)
  assert.doesNotMatch(describe("below", name), /^Call (only )?when the user asks/, `${name} isn't only for when the user asks`)
}
assert.match(describe("below", "pull_request_open"), /ready for review/)
assert.match(describe("below", "pull_request_merge"), /^Call only when the user asks/, "below full access, merging is the person's call")
assert.match(describe("full", "pull_request_merge"), /next step of the work/, "on full access a Thread merges as the next step of its work")
assert.match(describe("below", "worktree_bring"), /stayed: true/, "worktree_bring says it brings what a move left")
assert.match(describe("below", "worktree_bring"), /putBack/)
assert.match(describe("below", "worktree_move"), /On full access, or in a project that always allows it, it goes without asking/)

// 3. No agent-facing words leave the agent's own Git work to the person.
const HANDS_BACK = [
  /\b(user|person) can (bring|put|move|merge|open|push|commit|update|re-?run)\b[^.]*\b(app|panel|sidebar)\b/i,
  /\b(ask|tell) the (user|person) to (bring|put|move|merge|open|push|commit|update|re-?run|click)\b/i,
  /\bfrom (Mako's )?Changes panel\b/i,
  /\bunless the (user|person) brings\b/i,
  /\bdon't copy them yourself\b/i,
  /\bCall when the user asks to (open|re-?run|push)\b/i,
]
const texts: [string, string][] = [["policy", POLICY], ["primer", primerText({ role: "thread", noRecipe: false, computer: false })]]
for (const role of AGENT_TOOL_ROLES)
  for (const fullAccess of [false, true]) {
    const { instructions, tools } = await makoToolList(role, { fullAccess })
    texts.push([`${role} instructions`, instructions])
    for (const tool of tools) texts.push([`${role}${fullAccess ? " (full)" : ""} ${tool.name}`, `${tool.description ?? ""} ${JSON.stringify(tool.inputSchema)}`])
  }
texts.push(["move outcome", outcomeSentences(outcome).join(" ")], ["brought by the agent", broughtSentence(["e.ts"], "agent")], ["put back by the agent", returnedSentence(["b.ts"], "agent")])
for (const [where, text] of texts)
  for (const pattern of HANDS_BACK) assert.doesNotMatch(text, pattern, `${where} hands the agent's own Git work to the person`)
assert.match(POLICY, /Never ask the person to do in the app what a tool does/)
assert.match(outcomeSentences(outcome).join(" "), /worktree_bring putBack/, "what came on timing alone can be put back by the agent")
assert.match(outcomeSentences(outcome).join(" "), /worktree_bring stayed: true/, "what stayed can be brought by the agent")

console.log("own Git work: a move asks below full access and goes on it; open, push and re-run are the Thread's own at every tier, merging the person's below full; no agent-facing words hand that work to the person")
