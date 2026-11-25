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
 * - Which of Mako's own asks an agent's Git work meets under each access tier: a move onto its own branch goes without
 *   a card on every tier that may write and is refused with why on a read-only one; opening, pushing and re-running the
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

// 1. A move onto the Thread's own branch, under each tier: the agent's own work, so no card where it may write, and a
// refusal with why where it may not. The harness's own approval of the call, where its tier asks, is the person's say.
const root = mkdtempSync(join(tmpdir(), "mako-own-git-"))
try {
  const tiers = new Map<string, AccessTier | undefined>()
  const project = join(root, "project")
  const moves = (file: string, tiered = true) => new WorkspaceMoves({
    file,
    source: (id) => ({ cwd: project, harness: "claude", busy: true, title: id }),
    companions: () => [],
    place: async () => ({ project, changed: 1, shares: { thread: share(["a.ts"]), others: none, person: none, uncertain: share(["e.ts"]), unattributed: none, split: [] } }),
    move: async (id) => id,
    follow: async () => {},
    announce: () => {},
    failed: () => {},
    ...tiered && { tier: (id: string) => tiers.get(id) },
  })
  const each = moves(join(root, "moves.json"))
  const readOnly = new Set<AccessTier>(["plan", "chat", "deny"])
  for (const tier of [...ACCESS_TIER_NAMES, undefined]) {
    const id = `t-${tier ?? "none"}`
    tiers.set(id, tier)
    if (tier && readOnly.has(tier)) {
      await assert.rejects(each.ask(id), /where an agent changes no files, so it doesn't move onto a branch of its own\./, `${tier} refuses, saying why`)
      assert.equal(each.answerFor(id), undefined, `${tier} leaves no card for the person`)
      continue
    }
    const said = await each.ask(id)
    assert.equal(each.answerFor(id), "allowed", `${tier ?? "a harness without tiers"} moves without a card`)
    assert.match(said, /^Allowed: a move onto this Thread's own branch is your own work\./)
    assert.match(said, /worktree_bring brings those that are this Thread's/, "what stays says how the agent brings it, not that the person must")
  }
  assert.deepEqual(each.state().requests.filter((request) => request.state === "asking"), [], "nothing waits on the person")
  // A host that doesn't say a tier still asks, and a project that always allows it moves.
  const untiered = moves(join(root, "untiered.json"), false)
  assert.match(await untiered.ask("t-old"), /^Asked the user\./)
  untiered.answer(untiered.state().requests[0]!.id, "always")
  assert.match(await moves(join(root, "untiered.json"), false).ask("t-again"), /^Allowed: this project lets agents move without asking\./)
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
assert.match(describe("below", "worktree_move"), /It goes without asking, as your own work, except on a read-only access, where it's refused\./)

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
assert.match(outcomeSentences(outcome).join(" "), /may be the user's own\. Bring only those you've read and found are this Thread's work, each named in worktree_bring entries\./, "what nobody is named for comes only by name")

console.log("own Git work: a move goes without a card where the Thread may write and is refused where it may not; open, push and re-run are the Thread's own at every tier, merging the person's below full; no agent-facing words hand that work to the person")
