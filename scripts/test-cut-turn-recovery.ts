import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AgentsWorld, TESTED_HARNESSES } from "./lib/agents-world.ts"

async function until(test: () => boolean, why: string) {
  const deadline = performance.now() + 5_000
  while (!test()) {
    assert.ok(performance.now() < deadline, why)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const root = mkdtempSync(join(tmpdir(), "mako-cut-recovery-"))
try {
  for (const harness of TESTED_HARNESSES) {
    const world = new AgentsWorld({ root: join(root, `${harness}-close-queue`),
      script: async (turn) => turn.text === "Running before Close" ? turn.world.hold(turn.conversation).then(() => "Done") : "Done" })
    try {
      const { conversation } = await world.apex(harness, "full")
      const running = world.say(conversation, "Running before Close")
      await until(() => world.live.snapshot(conversation)?.requests.find(request => request.id === running)?.status === "dispatching", "the original turn did not start")
      const queued = [world.say(conversation, "Queued before Close one"), world.say(conversation, "Queued before Close two")]
      await until(() => queued.every(id => world.live.snapshot(conversation)?.requests.find(request => request.id === id)?.status === "queued"), "messages did not queue")
      await world.live.close(conversation)
      assert.equal(world.prompts.length, 1, "Close must not send queued messages")
      for (const id of queued) {
        const request = world.live.snapshot(conversation)!.requests.find(request => request.id === id)!
        assert.equal(request.pause, undefined, "Close is not the person's Stop")
        assert.equal(request.status, "queued", "a message never handed to the harness remains queued")
      }
      // A new message is the ordinary closed-conversation reopen route; no Resume or resumeHeld call.
      const reopened = world.say(conversation, "Reopen this conversation")
      await until(() => [reopened, ...queued].every(id => world.live.snapshot(conversation)?.requests.find(request => request.id === id)?.status === "completed"), "reopening did not release the queue without Resume")
      assert.deepEqual(world.prompts.map(prompt => prompt.text), ["Running before Close", "Queued before Close one", "Queued before Close two", "Reopen this conversation"], "reopen sends every queued message once, in order, without replaying the closed turn")
    } finally { await world.close() }
  }
  console.log("PASS: Close preserves ordinary queues; reopening sends them once without Resume on all harnesses")
  for (const harness of TESTED_HARNESSES) {
    for (const mode of ["default", "off", "two-restarts", "stop", "close", "queued", "after-admission"] as const) {
      let ownerHeld = false
      const world = new AgentsWorld({ ownerCheck: (_id, _created, turn) => ownerHeld && turn ? Date.now() : undefined, root: join(root, `${harness}-${mode}`), autoContinueDelayMs: 100,
        script: async (turn) => turn.text === "Original work" ? turn.world.hold(turn.conversation).then(() => "Done") : "Recovered" })
      try {
        const apex = await world.apex(harness, "full")
        assert.equal(world.store.edges().children(world.store.journalPlacement(apex.conversation)!.thread).length, 0, "the fixture is an ordinary Thread with no Fins")
        if (mode === "off") world.live.setConversationSettings({ continueAfterRestart: false })
        if (mode === "two-restarts" || mode === "stop") world.live.setConversationSettings({ continueAfterRestart: true })
        const first = world.say(apex.conversation, "Original work")
        await until(() => world.live.snapshot(apex.conversation)?.requests.find((request) => request.id === first)?.status === "dispatching", "the original turn never started")
        const queued = mode === "queued" ? [world.say(apex.conversation, "After one"), world.say(apex.conversation, "After two")] : []
        if (mode === "after-admission") ownerHeld = true
        await world.restart()
        if (mode === "after-admission") {
          await until(() => !!world.live.snapshot(apex.conversation)?.requests.find((request) => request.continues?.requestId === first), "the continuation was not admitted")
          const left = JSON.parse(readFileSync(join(world.root, "journals", "left-at-exit.json"), "utf8"))
          assert.ok(left.turns.some((turn: { requestId: string }) => turn.requestId === first), "admission is not native handoff; keep exit recovery for an unsent continuation")
          ownerHeld = false
          await world.restart()
        }
        if (mode === "two-restarts") {
          const left = JSON.parse(readFileSync(join(world.root, "journals", "left-at-exit.json"), "utf8"))
          assert.ok(left.turns.some((turn: { requestId: string }) => turn.requestId === first), "startup must retain the cut until its continuation is durably admitted")
          await world.restart()
        }
        if (mode === "stop" || mode === "close") {
          if (mode === "stop") await world.live.cancel(apex.conversation)
          else await world.live.close(apex.conversation)
          await world.restart()
        }
        if (mode === "off" || mode === "stop" || mode === "close") {
          await new Promise((resolve) => setTimeout(resolve, 250))
          assert.equal(world.prompts.length, 1, `${mode}: no automatic continuation`)
        } else {
          await until(() => world.prompts.length === 2 + queued.length, `${harness}/${mode}: the ordinary Thread did not resume its cut turn and queue`)
          const requests = world.live.snapshot(apex.conversation)!.requests
          const continuation = requests.find((request) => request.continues?.requestId === first)
          assert.ok(continuation)
          assert.equal(continuation.actor?.kind, "service")
          assert.deepEqual(world.prompts.slice(2).map((prompt) => prompt.text), queued.length ? ["After one", "After two"] : [])
          assert.ok(queued.every((id) => requests.find((request) => request.id === id)?.status === "completed"))
          assert.equal(world.prompts.filter((prompt) => prompt.text === "Original work").length, 1, "continue native work rather than replaying the original request")
        }
      } finally { await world.close() }
    }
  }
  console.log("PASS: ordinary Threads resume by default, explicit Off/Stop remain stopped, and a second restart cannot lose pending continuation")
} finally { rmSync(root, { recursive: true, force: true }) }
