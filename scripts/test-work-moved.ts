import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentsWorld } from "./lib/agents-world.ts"

/**
 * A conversation's work, as the account's row of it says it (working or not), is said as it moves, whether or not a
 * batch comes with it: a turn starting, ending, and the end's checkpoint released after its last batch. Before, a move
 * with no batch reached the account's list only at its next whole rebuild, now minutes apart.
 *
 *   npx tsx scripts/test-work-moved.ts
 */
const root = mkdtempSync(join(tmpdir(), "mako-work-moved-"))
const said: { conversation: string; status: string }[] = []
const world: AgentsWorld = new AgentsWorld({
  root,
  script: async (turn) => {
    if (turn.text.includes("hold")) await turn.world.hold(turn.conversation)
    return "ok"
  },
  workMoved: (conversation) => said.push({ conversation, status: world.live.workOf(conversation)?.status ?? "none" }),
})
try {
  const apex = await world.apex("claude")
  const before = said.length
  world.say(apex.conversation, "hold while it works")
  for (const deadline = Date.now() + 10_000; !said.slice(before).some((each) => each.status === "running"); await new Promise((resolve) => setTimeout(resolve, 10)))
    assert.ok(Date.now() < deadline, `its work never said it ran: ${JSON.stringify(said)}`)
  world.release(apex.conversation)
  await world.settle(400, 20_000, "ignore")
  const own = said.slice(before).filter((each) => each.conversation === apex.conversation).map((each) => each.status)
  assert.ok(own.includes("running"), "a turn starting is said")
  assert.equal(own.at(-1), "none", `and its end, its checkpoint included, last: ${own.join(" → ")}`)
  assert.equal(world.live.workOf(apex.conversation), undefined, "it has no work left")
  for (let at = 1; at < own.length; at++) assert.notEqual(own[at], own[at - 1], "each said once, as it moved")
  console.log(`work moved: ${own.join(" → ")}`)
} finally {
  await world.close()
  rmSync(root, { recursive: true, force: true })
}
