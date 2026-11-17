import "./lib/scratch-git.mjs"
// A turn's first write held on the real Grok CLI, in sealed homes, against the scripted model (no account; nothing
// leaves this machine). First, what Grok itself says loads in a folder (`grok inspect --json`), which decides whether a
// launch holds writes: nothing in a trusted folder; the person's hooks, which an untrusted folder doesn't report.
// Then Mako's own live driver: Grok asks over ACP (`_x.ai/hooks/run`) before its shell runs, and while the binding's
// write hold stands the model's command that writes a file doesn't run: the file isn't there and the model hears no
// result. Once the hold lets go, it runs.
//
//   npx tsx scripts/test-first-write-hold-grok-live.ts [--evidence <dir>]
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { CALL_GATE_HOLD_MS } from "@mako/host/harnesses/call-gate"
import { installGrok } from "@mako/host/harnesses/grok/index"
import { grokInspect, grokPersonCodeRuns } from "@mako/host/harnesses/grok/person-code"
import { WriteHolds } from "@mako/host/harnesses/write-holds"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

const args = process.argv.slice(2)
const evidenceAt = args.indexOf("--evidence")
const evidence = evidenceAt === -1 ? undefined : args[evidenceAt + 1]

/** How long the held command must stay unrun: past Grok's own turnaround, under the gate's deadline. */
const HELD_FOR_MS = 4_000
assert.ok(HELD_FOR_MS < CALL_GATE_HOLD_MS)
/** A request carrying the held call's result back to the model, by its id. */
const TOOL_RESULT = /"(tool_call_id|tool_use_id)"\s*:\s*"[^"]*call_write"|function_call_output[^}]{0,200}call_write|call_write[^}]{0,200}function_call_output/

// What Grok says loads, as a launch would ask it: its executable, the sealed home's environment and the folder.
await sandboxed("mako-grok-inspect", "grok", async (sandbox) => {
  const ask = (env: NodeJS.ProcessEnv = sandbox.env) => grokPersonCodeRuns(grokInspect("grok", env, sandbox.project), { servers: [] })
  assert.equal(await ask(), false, "a trusted folder with nothing of the person's: writes can be held")
  await mkdir(join(sandbox.home, ".grok", "hooks"), { recursive: true })
  await writeFile(join(sandbox.home, ".grok", "hooks", "start.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: "true" }] }] } }))
  await mkdir(join(sandbox.project, ".grok", "hooks"), { recursive: true })
  await writeFile(join(sandbox.project, ".grok", "hooks", "pre.json"), JSON.stringify({ hooks: { PreToolUse: [{ matcher: ".*", hooks: [{ type: "command", command: "true" }] }] } }))
  assert.equal(await ask(), true, "a folder Grok doesn't trust reports no hooks, so nothing is held")
  assert.equal(await ask({ ...sandbox.env, GROK_FOLDER_TRUST: "0" }), true, "trusted, Grok names the person's hooks, and nothing is held")
  console.log("PASS: Grok's own account of a folder holds writes only where it trusts it and names nothing of the person's")
})

const holds = new WriteHolds()
const driver = sealedDrivers([installGrok], { writeHolds: holds }).get("grok")
assert.ok(driver, "Grok's live driver registered")
assert.ok(driver.firstWrite, "Grok declares that it holds its agent's writes when the host gives it write holds")

try {
  await sandboxed("mako-first-write", "grok", async (sandbox) => {
    const target = join(sandbox.project, "held.txt")
    const heard: { at: number; body: string }[] = []
    const replies: ScriptedReply[] = [{ call: { id: "call_write", name: "run_terminal_command", arguments: { command: "echo written by the agent > held.txt", description: "Write the held file" } } }]
    const model = await scriptedModel({
      reply: (body) => {
        heard.push({ at: Date.now(), body })
        return replies.shift() ?? { text: "Done." }
      },
      answers: SCRIPTED_GETS,
    })
    const env = { ...sandbox.env }
    await pointAt("grok", sandbox, model.url, env, "first-write-hold")
    const id = randomUUID()
    const events: LiveDriverEvent[] = []
    const status = () => events.findLast((event) => event.type === "live-session")?.session.status
    const gate = Promise.withResolvers<void>()
    let early = 0
    const unhold = holds.hold(id, { until: gate.promise, frozen: () => false, wrote: () => { early += 1 } })
    const timeline: Record<string, number> = {}
    try {
      await driver.start(sandbox.project, admitted("grok", {
        conversationId: id, modeId: "access:full",
        emit: (event) => {
          events.push(event)
          // A command Grok asks about is answered as the person would: allowed.
          if (event.type === "live-permission") {
            const option = event.request.options?.find((candidate) => /allow/i.test(`${candidate.kind} ${candidate.optionId}`)) ?? event.request.options?.[0]
            if (option) void Promise.resolve(driver.permission(id, event.request.id, { kind: "choice", optionId: option.optionId }, { assertCurrent() {}, report() {} })).catch(() => {})
          }
        },
        mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
        nativeCalls: () => ({ folder: sandbox.project, recipe: { kind: "none" } }),
      }, { env }))
      assert.ok(holds.attends(id), "a sealed launch in a folder Grok trusts, with none of the person's own code, holds its writes")
      await driver.prompt(id, "Write held.txt.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
      const deadline = Date.now() + 120_000
      while (heard.length < 1 && Date.now() < deadline) await delay(50)
      assert.ok(heard.length >= 1, "Grok never asked the stand-in model")
      timeline.asked = heard[0]!.at
      await delay(HELD_FOR_MS)
      assert.equal(existsSync(target), false, `the held command hasn't run ${HELD_FOR_MS} ms after the model asked for it`)
      const results = () => heard.filter(({ body }) => TOOL_RESULT.test(body)).length
      assert.equal(results(), 0, "the model has heard no result for the held command")
      timeline.released = Date.now()
      gate.resolve()
      while (!existsSync(target) && Date.now() < deadline) await delay(20)
      timeline.written = Date.now()
      assert.equal(readFileSync(target, "utf8").trim(), "written by the agent", "once the hold lets go, the command runs")
      assert.ok(early >= 1, "the command let go before a freeze is said")
      while (Date.now() < deadline && !(results() > 0 && status() !== "running" && status() !== "starting")) await delay(100)
    } finally {
      gate.resolve()
      unhold()
      await Promise.resolve(driver.close(id)).catch(() => {})
      await model.close()
      if (evidence) {
        await mkdir(evidence, { recursive: true })
        await writeFile(join(evidence, "grok-first-write.json"), sandbox.scrub(JSON.stringify({ timeline, early, heard: heard.map(({ at }) => at), events }, null, 1)).replaceAll(homedir(), "~"))
      }
    }
    console.log(`PASS: Grok's held shell write stayed unrun ${HELD_FOR_MS} ms after the model asked for it; released, it ran ${timeline.written! - timeline.released!} ms later (early writes said: ${early})`)
  })
} finally {
  await driver.stop?.()
}
