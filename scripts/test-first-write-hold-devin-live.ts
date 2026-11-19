import "./lib/scratch-git.mjs"
// A turn's first write held on the real Devin CLI: Mako's own ACP driver, in a sealed home, against the scripted
// model (no account; nothing leaves this machine), with Mako's conversation server answering the PreToolUse hook the
// launch's copy of `config.json` installs for every tool that may write. While the binding's write hold stands, the
// model's `write` doesn't run: the file isn't there and the model hears no result. Once the hold lets go, the file is
// written. A read runs no hook and never waits.
//
//   npm run test:first-write-hold-devin-live [-- --evidence <dir>]
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { installDevin } from "@mako/host/harnesses/devin/index"
import { CALL_GATE_HOLD_MS, heldAnswer, HookCall } from "@mako/host/harnesses/call-gate"
import { WriteHolds } from "@mako/host/harnesses/write-holds"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed } from "./harness-sandbox.ts"
import { pointAt } from "./scripted-harness-env.ts"
import type { ScriptedReply } from "./scripted-model.ts"
import { scriptedWindsurf } from "./scripted-windsurf.ts"

const args = process.argv.slice(2)
const evidenceAt = args.indexOf("--evidence")
const evidence = evidenceAt === -1 ? undefined : args[evidenceAt + 1]

/** How long the held write must stay unwritten: past Devin's own turnaround, under the gate's deadline. */
const HELD_FOR_MS = 4_000
assert.ok(HELD_FOR_MS < CALL_GATE_HOLD_MS)

const holds = new WriteHolds()
const driver = sealedDrivers([installDevin], { writeHolds: holds }).get("devin")
assert.ok(driver, "Devin's live driver registered")
assert.ok(driver.firstWrite, "Devin declares that it holds its agent's writes when the host gives it write holds")

// Mako's conversation server, its gate holding as the host's does (`heldAnswer`): a call that may write waits on the turn.
const gated: string[] = []
const tools = await startConversationMcp({ authorizeAgent: () => {} }, async () => null, [() => {}], async (_conversation, event, body, binding) => {
  const call = HookCall.safeParse(body).data
  gated.push(`${event}:${call?.tool_name ?? "?"}`)
  return heldAnswer(holds, event, call, {}, binding)
})

try {
  await sandboxed("mako-first-write", "devin", async (sandbox) => {
    const target = join(sandbox.project, "held.txt")
    const heard: { at: number; body: string }[] = []
    await writeFile(join(sandbox.project, "notes.txt"), "already here\n")
    const replies: ScriptedReply[] = [
      { call: { id: "call_read", name: "read", arguments: { file_path: join(sandbox.project, "notes.txt") } } },
      { call: { id: "call_write", name: "write", arguments: { file_path: target, content: "written by the agent\n" } } },
    ]
    const model = await scriptedWindsurf({
      reply: (body) => {
        heard.push({ at: Date.now(), body })
        return replies.shift() ?? { text: "Done." }
      },
    })
    const env = { ...sandbox.env }
    await pointAt("devin", sandbox, model.url, env, "first-write-hold")
    if (!env.HOME?.startsWith(sandbox.home) || !env.XDG_CONFIG_HOME?.startsWith(sandbox.home)) throw new Error("Devin's home is outside its sealed home; nothing was started")
    const id = randomUUID()
    const grant = tools.mint(id, id)
    assert.ok(grant.makoUrl, "the conversation server serves `mako`, so Devin gets its hook")
    const events: LiveDriverEvent[] = []
    const status = () => events.findLast((event) => event.type === "live-session")?.session.status
    const gate = Promise.withResolvers<void>()
    let early = 0
    const unhold = holds.hold(id, { until: gate.promise, frozen: () => false, wrote: () => { early += 1 } })
    const timeline: Record<string, number> = {}
    try {
      await driver.start(sandbox.project, admitted("devin", {
        conversationId: id, emit: (event) => events.push(event), modeId: "bypass",
        mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
        nativeCalls: () => ({ folder: sandbox.project, recipe: { kind: "none" } }),
        conversationTools: grant,
      }, { env }))
      assert.ok(holds.attends(id), "a sealed launch with Mako's hook and none of the person's own holds its writes")
      await driver.prompt(id, "Add held.txt.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
      const deadline = Date.now() + 90_000
      while (!gated.includes("pre:write") && Date.now() < deadline) await delay(50)
      assert.ok(gated.includes("pre:write"), `Devin's hook posted the write before running it (heard: ${gated.join(", ")})`)
      assert.ok(!gated.includes("pre:read"), `the read before it ran no hook at all (heard: ${gated.join(", ")})`)
      assert.equal(early, 0, "and nothing went early")
      assert.ok(heard.length >= 2, "the model heard the read's result while the hold stood")
      timeline.writeGated = Date.now()
      const heardBefore = heard.length
      await delay(HELD_FOR_MS)
      assert.equal(existsSync(target), false, `the held write hasn't run ${HELD_FOR_MS} ms after Devin asked`)
      assert.equal(heard.length, heardBefore, "the model has heard no result for the held write")
      timeline.released = Date.now()
      gate.resolve()
      while (!existsSync(target) && Date.now() < deadline) await delay(20)
      timeline.written = Date.now()
      assert.equal(readFileSync(target, "utf8").trim(), "written by the agent", "once the hold lets go, the file is written")
      assert.equal(early, 1, "the write let go before a freeze is said once")
      while (Date.now() < deadline && !(heard.length > heardBefore && status() !== "running" && status() !== "starting")) await delay(100)
    } finally {
      gate.resolve()
      unhold()
      await Promise.resolve(driver.close(id)).catch(() => {})
      await model.close()
      if (evidence) {
        await mkdir(evidence, { recursive: true })
        await writeFile(join(evidence, "devin-first-write.json"), sandbox.scrub(JSON.stringify({ timeline, gated, heard: heard.map(({ at }) => at), events }, null, 1)).replaceAll(homedir(), "~"))
      }
    }
    console.log(`PASS: Devin's held write stayed unwritten ${HELD_FOR_MS} ms after its hook asked, with a read before it that ran no hook; released, it was written ${timeline.written! - timeline.released!} ms later`)
  })
} finally {
  await tools.close?.()
  await driver.stop?.()
}
