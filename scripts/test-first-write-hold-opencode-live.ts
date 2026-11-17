import "./lib/scratch-git.mjs"
// A turn's first write held on the real OpenCode CLI: Mako's own live driver, in a sealed home, against the scripted
// model (no account; nothing leaves this machine). OpenCode's plugin posts each call to Mako's conversation server
// (`heldAnswer`). While the binding's write hold stands, the model's shell command that writes a file doesn't run: the
// file isn't there and the model hears no result. Once the hold lets go, it runs. OpenCode itself said, once its
// plugins were active, that none of the person's code runs beside Mako's plugin (`openCodePersonCodeRuns`).
//
//   npx tsx scripts/test-first-write-hold-opencode-live.ts [--evidence <dir>]
import assert from "node:assert/strict"
import { randomUUID } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { mkdir, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { JsonObject } from "@mako/host/contracts/json"
import type { LiveDriverEvent } from "@mako/host/contracts/live-conversations"
import { CALL_GATE_HOLD_MS, heldAnswer, HookCall } from "@mako/host/harnesses/call-gate"
import { installOpenCode } from "@mako/host/harnesses/opencode/index"
import { WriteHolds } from "@mako/host/harnesses/write-holds"
import { startConversationMcp } from "@mako/host/tools/conversation-mcp"
import { admitted } from "./fixtures/admitted-start.ts"
import { sealedDrivers } from "./fixtures/sealed-drivers.ts"
import { sandboxed } from "./harness-sandbox.ts"
import { pointAt, SCRIPTED_GETS } from "./scripted-harness-env.ts"
import { scriptedModel, type ScriptedReply } from "./scripted-model.ts"

const args = process.argv.slice(2)
const evidenceAt = args.indexOf("--evidence")
const evidence = evidenceAt === -1 ? undefined : args.splice(evidenceAt, 2)[1]

/** How long the held command must stay unrun: past the harness's own turnaround, under the gate's deadline. */
const HELD_FOR_MS = 4_000
assert.ok(HELD_FOR_MS < CALL_GATE_HOLD_MS)

/** Each harness's shell tool as its model calls it, and the mode its turn runs in. */
const SHELLS = new Map<string, { tool: string; arguments: (command: string) => JsonObject; mode?: string }>([
  // OpenCode 2's shell tool, as `harness-decode-pairs.ts` calls it.
  ["opencode", { tool: "shell", arguments: (command) => ({ command }), mode: "access:full" }],
])
const harnesses = args.length ? args : [...SHELLS.keys()]
/** A request carrying the held call's result back to the model, by its id, in the wires these harnesses speak. */
const TOOL_RESULT = /"(tool_call_id|tool_use_id)"\s*:\s*"[^"]*call_write"|function_call_output[^}]{0,200}call_write|call_write[^}]{0,200}function_call_output/

const holds = new WriteHolds()
const drivers = sealedDrivers([installOpenCode], { writeHolds: holds })
const gated: string[] = []
const tools = await startConversationMcp({ authorizeAgent: () => {} }, async () => null, [() => {}], async (_conversation, event, body, binding) => {
  const call = HookCall.safeParse(body).data
  gated.push(`${event}:${call?.tool_name ?? "?"}`)
  return heldAnswer(holds, event, call, {}, binding)
})

try {
  for (const harness of harnesses) {
    const shell = SHELLS.get(harness)
    const driver = drivers.get(harness)
    assert.ok(shell && driver, `${harness} has a shell here and its driver registered`)
    assert.ok(driver.firstWrite, `${harness} declares that it holds its agent's writes when the host gives it write holds`)
    await sandboxed("mako-first-write", harness, async (sandbox) => {
      const target = join(sandbox.project, "held.txt")
      const heard: { at: number; body: string }[] = []
      const replies: ScriptedReply[] = [{ call: { id: "call_write", name: shell.tool, arguments: shell.arguments("echo written by the agent > held.txt") } }]
      const model = await scriptedModel({
        reply: (body) => {
          heard.push({ at: Date.now(), body })
          return replies.shift() ?? { text: "Done." }
        },
        answers: SCRIPTED_GETS,
      })
      const env = { ...sandbox.env }
      await pointAt(harness, sandbox, model.url, env, "first-write-hold")
      const id = randomUUID()
      const grant = tools.mint(id, id)
      const events: LiveDriverEvent[] = []
      const status = () => events.findLast((event) => event.type === "live-session")?.session.status
      const gate = Promise.withResolvers<void>()
      let early = 0
      const unhold = holds.hold(id, { until: gate.promise, frozen: () => false, wrote: () => { early += 1 } })
      const timeline: Record<string, number> = {}
      try {
        await driver.start(sandbox.project, admitted(harness, {
          conversationId: id, ...shell.mode && { modeId: shell.mode },
          emit: (event) => {
            events.push(event)
            // A harness that asks before a command is answered as the person would: allowed.
            if (event.type === "live-permission") {
              const option = event.request.options?.find((candidate) => /allow/i.test(`${candidate.kind} ${candidate.optionId}`)) ?? event.request.options?.[0]
              if (option) void Promise.resolve(driver.permission(id, event.request.id, { kind: "choice", optionId: option.optionId }, { assertCurrent() {}, report() {} })).catch(() => {})
            }
          },
          mcpSnapshot: async () => ({ cwd: sandbox.project, generatedAt: Date.now(), servers: [], providers: [] }),
          nativeCalls: () => ({ folder: sandbox.project, recipe: { kind: "none" } }),
          conversationTools: grant,
        }, { env }))
        assert.ok(holds.attends(id), `${harness}: a sealed launch with Mako's hooks and none of the person's own holds its writes`)
        await driver.prompt(id, "Write held.txt.", [], undefined, { operationId: randomUUID(), attemptId: randomUUID(), report: () => {} })
        const deadline = Date.now() + 120_000
        while (heard.length < 1 && Date.now() < deadline) await delay(50)
        assert.ok(heard.length >= 1, `${harness} never asked the stand-in model`)
        timeline.asked = heard[0]!.at
        // The model's call, then the hold: the command must not have run, nor the model heard its result.
        await delay(HELD_FOR_MS)
        assert.equal(existsSync(target), false, `${harness}: the held command hasn't run ${HELD_FOR_MS} ms after the model asked for it (gated: ${gated.join(", ")})`)
        // A harness asks its model for more than the turn (a title): only a request carrying the call's result counts.
        const results = () => heard.filter(({ body }) => TOOL_RESULT.test(body)).length
        assert.equal(results(), 0, `${harness}: the model has heard no result for the held command`)
        timeline.released = Date.now()
        gate.resolve()
        while (!existsSync(target) && Date.now() < deadline) await delay(20)
        timeline.written = Date.now()
        assert.equal(readFileSync(target, "utf8").trim(), "written by the agent", `${harness}: once the hold lets go, the command runs`)
        assert.equal(early, 1, `${harness}: the command let go before a freeze is said once`)
        while (Date.now() < deadline && !(results() > 0 && status() !== "running" && status() !== "starting")) await delay(100)
      } finally {
        gate.resolve()
        unhold()
        await Promise.resolve(driver.close(id)).catch(() => {})
        await model.close()
        if (evidence) {
          await mkdir(evidence, { recursive: true })
          await writeFile(join(evidence, `${harness}-first-write.json`), sandbox.scrub(JSON.stringify({ timeline, gated, heard: heard.map(({ at }) => at), events }, null, 1)).replaceAll(homedir(), "~"))
        }
      }
      console.log(`PASS: ${harness}'s held shell write stayed unrun ${HELD_FOR_MS} ms after the model asked for it; released, it ran ${timeline.written! - timeline.released!} ms later`)
    })
  }
} finally {
  await tools.close?.()
  for (const driver of drivers.values()) await driver.stop?.()
}
