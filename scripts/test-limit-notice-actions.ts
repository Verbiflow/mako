import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { providerTextEvidence } from "@mako/host/contracts/provider-failure"
import { AgentsWorld, HARNESSES, type WorldAccount } from "./lib/agents-world.ts"

async function until(why: string, test: () => boolean) {
  const end = performance.now() + 12_000
  while (!test()) { assert.ok(performance.now() < end, why); await new Promise(resolve => setTimeout(resolve, 10)) }
}
const root = mkdtempSync(join(tmpdir(), "mako-shiver-limit-"))
try {
  for (const mode of ["move", "stop", "stop-during-read", "restart"] as const) {
    const reset = Date.now() + 3_600_000
    const accounts: Partial<Record<string, WorldAccount[]>> = Object.fromEntries(HARNESSES.map(h => {
      const account: WorldAccount = { name: "default" }
      if (h !== "claude") account.spentUntil = reset
      return [h, [account]]
    }))
    let cancelOnRead = false
    const children: { thread: string; conversation: string }[] = []
    const world = new AgentsWorld({ root: join(root, mode), accounts,
      readingAccounts: async (harness, all) => {
        if (cancelOnRead && harness === "claude" && all) {
          cancelOnRead = false
          for (const child of children) await world.live.cancel(child.conversation)
        }
      },
      catalogs: Object.fromEntries(HARNESSES.map(harness => [harness, [{ id: `${harness}-model`, label: `${harness} model`, options: [] }]])),
      script: turn => turn.text.includes("You're fin:") ? turn.world.hold(turn.conversation).then(() => "Done") : "Done" })
    try {
      const apex = await world.apex("claude", "full")
      for (const name of ["one", "two"]) {
        const fin = await world.agents.start(apex.caller, { name, harness: "claude", cwd: world.root, clientKey: name, brief: { objective: "Keep this work" } })
        assert.ok(!("refused" in fin) && fin.conversation && fin.child)
        children.push({ thread: fin.child, conversation: fin.conversation })
        await until("Fin starts", () => world.live.session(fin.conversation!)?.status === "running")
      }
      accounts.claude![0]!.spentUntil = reset
      const text = "You've hit your usage limit"
      for (const child of children) {
        world.endWith(child.conversation, { fail: text, failureEvidence: providerTextEvidence(text), limit: { resetsAt: reset } })
        world.release(child.conversation)
      }
      const notice = () => world.agents.roster(apex.conversation).find(agent => agent.child?.limitNotice)?.child?.limitNotice
      await until("one typed Shiver notice", () => notice()?.waiting?.count === 2)
      assert.equal(notice()!.waiting!.at, reset)
      assert.equal(notice()!.waiting!.resets, true)
      assert.equal(world.agents.roster(apex.conversation).filter(agent => agent.child?.limitNotice).length, 1)
      assert.equal(await world.agents.nextPlace(apex.conversation, notice()!.id), undefined, "no fake alternative when every account is full")
      const id = notice()!.id
      if (mode === "restart") {
        await world.restart()
        await until("reset facts survive restart", () => notice()?.waiting?.count === 2)
        assert.equal(notice()!.waiting!.at, reset)
      }
      delete accounts.codex![0]!.spentUntil
      const next = await world.agents.nextPlace(apex.conversation, id)
      assert.equal(next?.harness, "codex")
      assert.ok(next?.choice)
      assert.equal(next.choice.waits.length, 2)
      const foreign = await world.apex("codex", "full")
      assert.equal(await world.agents.continueNext(foreign.conversation, randomUUID(), next.choice), false, "another tree cannot use this notice")
      assert.equal(await world.agents.continueNext(apex.conversation, randomUUID(), { ...next.choice, waits: next.choice.waits.map(wait => ({ ...wait, request: randomUUID() })) }), false, "an exact request mismatch admits nothing")
      if (mode === "stop") {
        for (const child of children) await world.live.cancel(child.conversation)
        assert.equal(await world.agents.continueNext(apex.conversation, randomUUID(), next.choice), false, "Stop after the read outranks its action")
        continue
      }
      if (mode === "stop-during-read") {
        cancelOnRead = true
        assert.equal(await world.agents.continueNext(apex.conversation, randomUUID(), next.choice), false, "Stop during the awaited capacity read outranks dispatch")
        assert.equal(cancelOnRead, false, "the race reached its real account read")
        continue
      }
      accounts.codex![0]!.spentUntil = reset
      assert.equal(await world.agents.continueNext(apex.conversation, randomUUID(), next.choice), false, "lost capacity is rechecked before dispatch")
      delete accounts.codex![0]!.spentUntil
      const request = randomUUID()
      assert.equal(await world.agents.continueNext(apex.conversation, request, next.choice), true, "one explicit action moves eligible exact waits")
      await until("both Fins moved", () => children.every(child => world.live.session(child.conversation)?.harness === "codex"))
      const heard = world.prompts.length
      assert.equal(await world.agents.continueNext(apex.conversation, request, next.choice), false, "duplicate/stale action cannot redispatch")
      assert.equal(world.prompts.length, heard)
      assert.equal(notice(), undefined, "settled recovery does not leave a Got it task")
    } finally { await world.close() }
  }
  console.log("PASS: one Shiver reset notice; real fallback, no room, exact request/tree, stale receipt, Stop and restart controls")
} finally { rmSync(root, { recursive: true, force: true }) }
