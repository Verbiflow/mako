import assert from "node:assert/strict"
import { FIN_SUBAGENT, POLICY, primerBlocks, primerText, ROUTES_LEAD, type PrimerThread } from "@mako/host/contracts/primer"
import { CLAUDE_FIN_DEFINITION, CLAUDE_START_TOOL } from "@mako/host/harnesses/claude/routing"
import { launchInstructions } from "@mako/host/harnesses/live-driver"
import { SHOW_MEDIA_LINE } from "@mako/sessions/turn-media"

const thread: PrimerThread = { role: "thread", noRecipe: false, computer: true }
const [routes, policy] = primerBlocks(thread)
assert.deepEqual([routes.id, policy.id], ["routes", "policy"])
assert.equal(routes.text.split("\n")[0], ROUTES_LEAD)
assert.equal(policy.text, POLICY)
for (const line of ["Prefer worktree_move", "Prefer pull_request_open", "app_probe to check", "Prefer agents_start", "Prefer the js tool on mako-computer", "Prefer thread_history", "git worktree add", "gh pr merge is refused"])
  assert.ok(routes.text.includes(line), line)
assert.equal(routes.text.includes("Not `"), false)
for (const rule of ["only when the person asks", "Never put a token", "Say what wasn't run or verified"])
  assert.ok(policy.text.includes(rule), rule)

const apex = primerText({ ...thread, role: "apex" })
assert.ok(apex.includes("Prefer agents_send"))
const noRecipe = primerText({ ...thread, noRecipe: true })
assert.ok(noRecipe.includes("Prefer recipe_guide"))
assert.equal(noRecipe.includes("Prefer app_start"), false)
const noComputer = primerText({ ...thread, computer: false })
assert.equal(noComputer.includes("mako-computer"), false)

const tools = { token: "t", computerUrl: "http://127.0.0.1/computer", makoUrl: "http://127.0.0.1/mako" }
assert.equal(launchInstructions({ conversationTools: tools, primer: false }), SHOW_MEDIA_LINE)
assert.equal(launchInstructions({ conversationTools: tools }), primerText(thread))
assert.equal(launchInstructions({}), undefined)
assert.equal(CLAUDE_FIN_DEFINITION.tools[0], CLAUDE_START_TOOL)
assert.equal(FIN_SUBAGENT.tools[0], "agents_start")

const full = primerText(thread)
console.log(`primer: routes ${routes.text.length} chars, policy ${policy.text.length}, both ${full.length}`)
